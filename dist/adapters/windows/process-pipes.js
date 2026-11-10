import { CloseHandle, CreatePipe, DeleteProcThreadAttributeList, GetLastError, InitializeProcThreadAttributeList, PeekNamedPipe, ReadFile, readHandle, SetHandleInformation, STARTF_USESTDHANDLES, UpdateProcThreadAttribute, writePointer, } from "./koffi-bindings.js";
/** Only these three handles may cross the CreateProcess boundary (Windows x64). */
export function createProcessPipes() {
    const owned = new Set();
    let attributes = null;
    let attributesInitialized = false;
    function close(handle) {
        if (owned.delete(handle))
            CloseHandle(handle);
    }
    function dispose() {
        if (attributesInitialized) {
            DeleteProcThreadAttributeList(attributes);
            attributesInitialized = false;
        }
        for (const handle of [...owned])
            close(handle);
    }
    function pipe(parentReads) {
        const security = Buffer.alloc(24);
        security.writeUInt32LE(24, 0);
        security.writeUInt32LE(1, 16);
        const read = Buffer.alloc(8);
        const write = Buffer.alloc(8);
        if (!CreatePipe(read, write, security, 64 * 1024))
            throw new Error("pipe_create_failed");
        const pair = { read: readHandle(read, 0), write: readHandle(write, 0) };
        owned.add(pair.read);
        owned.add(pair.write);
        if (!SetHandleInformation(parentReads ? pair.read : pair.write, 1, 0))
            throw new Error("pipe_inheritance_failed");
        return pair;
    }
    try {
        const stdout = pipe(true);
        const stderr = pipe(true);
        const stdin = pipe(false);
        const size = Buffer.alloc(8);
        InitializeProcThreadAttributeList(null, 1, 0, size);
        const length = Number(size.readBigUInt64LE());
        if (!Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024)
            throw new Error("pipe_attribute_failed");
        attributes = Buffer.alloc(length);
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, size))
            throw new Error("pipe_attribute_failed");
        attributesInitialized = true;
        const handles = Buffer.alloc(24);
        handles.writeBigUInt64LE(stdin.read, 0);
        handles.writeBigUInt64LE(stdout.write, 8);
        handles.writeBigUInt64LE(stderr.write, 16);
        if (!UpdateProcThreadAttribute(attributes, 0, 0x0002_0002, handles, handles.length, null, null))
            throw new Error("pipe_attribute_failed");
        const startupInfo = Buffer.alloc(112);
        startupInfo.writeUInt32LE(112, 0);
        startupInfo.writeUInt32LE(STARTF_USESTDHANDLES, 60);
        startupInfo.writeBigUInt64LE(stdin.read, 80);
        startupInfo.writeBigUInt64LE(stdout.write, 88);
        startupInfo.writeBigUInt64LE(stderr.write, 96);
        writePointer(startupInfo, 104, attributes);
        return {
            startupInfo,
            // Retain the attribute value buffer through CreateProcessW.
            handles,
            stdout: stdout.read,
            stderr: stderr.read,
            created() {
                close(stdin.read);
                close(stdin.write);
                close(stdout.write);
                close(stderr.write);
            },
            dispose,
        };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
/** Peek before synchronous ReadFile: one reader, bounded read, no empty-pipe wait. */
export function readAvailablePipe(handle, buffer, maxBytes) {
    const available = Buffer.alloc(4);
    if (!PeekNamedPipe(handle, null, 0, null, available, null))
        return { kind: GetLastError() === 109 ? "eof" : "failed" };
    const length = Math.min(available.readUInt32LE(), buffer.length, maxBytes);
    if (length === 0)
        return { kind: "idle" };
    const read = Buffer.alloc(4);
    if (!ReadFile(handle, buffer, length, read, null))
        return { kind: "failed" };
    const count = read.readUInt32LE();
    if (count <= 0 || count > length)
        return { kind: "failed" };
    return { kind: "data", bytes: buffer.subarray(0, count) };
}
