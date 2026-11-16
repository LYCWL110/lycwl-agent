import koffi, {} from "koffi";
/**
 * Minimal Windows Credential Manager surface (G03).
 *
 * Only generic credentials with local-machine persistence are bound, matching
 * the selected vault route. No domain or session credential types are exposed.
 *
 * Every export here is a raw binding; the adapter decides policy. Reading a real
 * credential remains gated by G03 and must not be treated as validated merely
 * because the binding compiles.
 *
 * The libraries are loaded only on win32, so importing this module elsewhere
 * never opens `advapi32.dll` or `kernel32.dll`.
 */
const isWindows = process.platform === "win32";
const advapi32 = isWindows ? koffi.load("advapi32.dll") : null;
// `GetLastError` lives in kernel32, not advapi32. Loading it from the wrong
// module throws at import time, which would make the whole adapter unusable
// instead of merely failing closed.
const kernel32 = isWindows ? koffi.load("kernel32.dll") : null;
/** Fails closed on platforms without the Windows DLLs; see koffi-bindings.ts. */
const unavailable = (() => {
    throw new Error(`Windows credential bindings are unavailable on ${process.platform}`);
});
function bind(library, signature) {
    return library === null ? unavailable : library.func(signature);
}
export const CRED_TYPE_GENERIC = 1;
export const CRED_PERSIST_LOCAL_MACHINE = 2;
export const ERROR_NOT_FOUND = 1168;
/**
 * CREDENTIALW, x64 layout (80 bytes):
 *   0  Flags(u32)            4  Type(u32)
 *   8  TargetName(ptr)      16  Comment(ptr)
 *  24  LastWritten(8)       32  CredentialBlobSize(u32)
 *  40  CredentialBlob(ptr)  48  Persist(u32)
 *  52  AttributeCount(u32)  56  Attributes(ptr)
 *  64  TargetAlias(ptr)     72  UserName(ptr)
 */
export const CredentialW = koffi.struct("CREDENTIALW", {
    Flags: "uint32_t",
    Type: "uint32_t",
    TargetName: "void *",
    Comment: "void *",
    LastWrittenLow: "uint32_t",
    LastWrittenHigh: "uint32_t",
    CredentialBlobSize: "uint32_t",
    CredentialBlob: "void *",
    Persist: "uint32_t",
    AttributeCount: "uint32_t",
    Attributes: "void *",
    TargetAlias: "void *",
    UserName: "void *",
});
export const CredReadW = bind(advapi32, "bool __stdcall CredReadW(const char16_t* TargetName, uint32_t Type, uint32_t Flags, _Out_ void** Credential)");
export const CredWriteW = bind(advapi32, "bool __stdcall CredWriteW(void* Credential, uint32_t Flags)");
export const CredDeleteW = bind(advapi32, "bool __stdcall CredDeleteW(const char16_t* TargetName, uint32_t Type, uint32_t Flags)");
export const CredFree = bind(advapi32, "void __stdcall CredFree(void* Buffer)");
export const GetLastError = bind(kernel32, "uint32_t __stdcall GetLastError()");
/**
 * Decode the UTF-16 credential blob. `CredentialBlob` points at raw bytes of
 * `CredentialBlobSize`; it is copied and the caller frees the struct separately.
 */
export function readBlob(credential) {
    const record = credential;
    const pointer = record.CredentialBlob;
    const size = record.CredentialBlobSize;
    if (pointer === null || pointer === undefined || size === 0)
        return "";
    // `koffi.decode` copies `size` bytes from the pointer into a Buffer.
    const bytes = koffi.decode(pointer, "uint8_t", size);
    return bytes.toString("utf16le");
}
