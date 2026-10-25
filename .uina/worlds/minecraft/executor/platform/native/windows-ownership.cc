#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <sddl.h>
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { close(); }
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
struct Owner { Handle directory; Handle account; uint64_t id; };
struct Process { Handle handle; uint64_t owner; DWORD pid; uint64_t creation; };
std::atomic<uint64_t> nextOwner{1};
struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string c, std::string detail) : std::runtime_error(c + ": " + detail), code(std::move(c)) {}
};
[[noreturn]] void fail(const char* code) {
  throw Failure(code, "Windows error " + std::to_string(GetLastError()));
}
void check(napi_status status) { if (status != napi_ok) throw Failure("NATIVE_API_ERROR", "Node-API call failed"); }
napi_value undefined(napi_env env) { napi_value result; check(napi_get_undefined(env, &result)); return result; }
napi_value string(napi_env env, const std::string& value) { napi_value result; check(napi_create_string_utf8(env, value.c_str(), value.size(), &result)); return result; }
napi_value number(napi_env env, uint32_t value) { napi_value result; check(napi_create_uint32(env, value, &result)); return result; }
void set(napi_env env, napi_value object, const char* key, napi_value value) { check(napi_set_named_property(env, object, key, value)); }
std::wstring wide(napi_env env, napi_value value) {
  size_t size; check(napi_get_value_string_utf16(env, value, nullptr, 0, &size));
  std::vector<char16_t> buffer(size + 1);
  check(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &size));
  return std::wstring(reinterpret_cast<wchar_t*>(buffer.data()), size);
}
template<typename T> T* external(napi_env env, napi_value value) {
  void* pointer; check(napi_get_value_external(env, value, &pointer)); return static_cast<T*>(pointer);
}
Owner* owner(napi_env env, napi_value value) {
  auto result = external<Owner>(env, value);
  if (!result->directory.value || !result->account.value) throw Failure("OWNERSHIP_CLOSED", "Jobs are closed");
  return result;
}
Process* process(napi_env env, napi_value value) {
  auto result = external<Process>(env, value);
  if (!result->handle.value) throw Failure("PROCESS_CLOSED", "Process handle is closed");
  return result;
}
void belongs(Owner* o, Process* p) { if (o->id != p->owner) throw Failure("PROCESS_OWNERSHIP", "Foreign process handle"); }
uint64_t creation(HANDLE process) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) fail("PROCESS_IDENTITY_FAILED");
  return (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
napi_value identity(napi_env env, DWORD pid, uint64_t created) {
  napi_value result; check(napi_create_object(env, &result));
  set(env, result, "pid", number(env, pid)); set(env, result, "createdAt", string(env, std::to_string(created)));
  return result;
}
DWORD active(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &information, sizeof(information), nullptr)) fail("JOB_QUERY_FAILED");
  return information.ActiveProcesses;
}
std::wstring directoryName(const std::wstring& path) {
  Handle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (directory.value == INVALID_HANDLE_VALUE) fail("DATA_DIR_OPEN_FAILED");
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(directory.value, FileBasicInfo, &basic, sizeof(basic))) fail("DATA_DIR_IDENTITY_FAILED");
  if (!(basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) throw Failure("DATA_DIR_INVALID", "Expected an existing directory");
  FILE_ID_INFO information{};
  if (!GetFileInformationByHandleEx(directory.value, FileIdInfo, &information, sizeof(information))) fail("DATA_DIR_IDENTITY_FAILED");
  const wchar_t* hex = L"0123456789abcdef";
  std::wstring result = L"Global\\Uina.Minecraft.Directory.";
  for (int shift = 60; shift >= 0; shift -= 4) result += hex[(information.VolumeSerialNumber >> shift) & 15];
  result += L'.';
  for (auto byte : information.FileId.Identifier) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
struct Security {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  Security() {
    Handle token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) fail("JOB_SECURITY_FAILED");
    DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> buffer(size);
    if (!GetTokenInformation(token.value, TokenUser, buffer.data(), size, &size)) fail("JOB_SECURITY_FAILED");
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid)) fail("JOB_SECURITY_FAILED");
    std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
    LocalFree(sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) fail("JOB_SECURITY_FAILED");
    attributes.nLength = sizeof(attributes); attributes.lpSecurityDescriptor = descriptor; attributes.bInheritHandle = FALSE;
  }
  ~Security() { if (descriptor) LocalFree(descriptor); }
};
void createJob(Handle& target, const std::wstring& name, const char* busy) {
  Security security;
  SetLastError(ERROR_SUCCESS);
  target.value = CreateJobObjectW(&security.attributes, name.c_str());
  DWORD error = GetLastError();
  if (!target.value) fail("JOB_CREATE_FAILED");
  // Never inspect or mutate an existing job, even if it appears empty.
  if (error == ERROR_ALREADY_EXISTS) { target.close(); throw Failure(busy, "Named Job already exists"); }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(target.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("JOB_CONFIGURE_FAILED");
}
template<typename T> void finalize(napi_env, void* value, void*) { delete static_cast<T*>(value); }
using Handler = napi_value (*)(napi_env, const std::vector<napi_value>&);
template<Handler fn> napi_value callback(napi_env env, napi_callback_info info) {
  try {
    size_t count = 3; std::vector<napi_value> args(count);
    check(napi_get_cb_info(env, info, &count, args.data(), nullptr, nullptr)); args.resize(count);
    return fn(env, args);
  } catch (const Failure& error) { napi_throw_error(env, error.code.c_str(), error.what()); }
    catch (const std::exception& error) { napi_throw_error(env, "NATIVE_ERROR", error.what()); }
  return nullptr;
}
napi_value selfIdentity(napi_env env, const std::vector<napi_value>&) { return identity(env, GetCurrentProcessId(), creation(GetCurrentProcess())); }
napi_value acquire(napi_env env, const std::vector<napi_value>& args) {
  auto result = std::make_unique<Owner>(); result->id = nextOwner++;
  createJob(result->directory, directoryName(wide(env, args.at(0))), "DATA_DIR_BUSY");
  createJob(result->account, L"Global\\Uina.Minecraft.Account." + wide(env, args.at(1)), "ACCOUNT_BUSY");
  napi_value value; check(napi_create_external(env, result.get(), finalize<Owner>, nullptr, &value)); result.release(); return value;
}
napi_value openProcess(napi_env env, const std::vector<napi_value>& args) {
  auto o = owner(env, args.at(0)); uint32_t pid; check(napi_get_value_uint32(env, args.at(1), &pid));
  auto result = std::make_unique<Process>(); result->owner = o->id; result->pid = pid;
  result->handle.value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
  if (!result->handle.value) fail("PROCESS_OPEN_FAILED");
  result->creation = creation(result->handle.value);
  napi_value value, handle; check(napi_create_object(env, &value));
  check(napi_create_external(env, result.get(), finalize<Process>, nullptr, &handle));
  auto p = result.release(); set(env, value, "handle", handle); set(env, value, "identity", identity(env, p->pid, p->creation)); return value;
}
napi_value closeProcess(napi_env env, const std::vector<napi_value>& args) { external<Process>(env, args.at(0))->handle.close(); return undefined(env); }
napi_value terminateProcess(napi_env env, const std::vector<napi_value>& args) {
  auto p = process(env, args.at(0));
  if (WaitForSingleObject(p->handle.value, 0) != WAIT_OBJECT_0 && !TerminateProcess(p->handle.value, 1)) fail("PROCESS_TERMINATE_FAILED");
  return undefined(env);
}
napi_value assign(napi_env env, const std::vector<napi_value>& args) {
  auto o = owner(env, args.at(0)); auto p = process(env, args.at(1)); belongs(o, p);
  if (GetProcessId(p->handle.value) != p->pid || creation(p->handle.value) != p->creation) throw Failure("PROCESS_IDENTITY_CHANGED", "Opened process identity changed");
  if (!AssignProcessToJobObject(o->directory.value, p->handle.value)) fail("DIRECTORY_ASSIGN_FAILED");
  // On the second assignment failure the directory still owns the bootstrap.
  // Caller terminates that exact handle and awaits both Jobs before releasing ownership.
  if (!AssignProcessToJobObject(o->account.value, p->handle.value)) fail("ACCOUNT_ASSIGN_FAILED");
  return undefined(env);
}
napi_value terminate(napi_env env, const std::vector<napi_value>& args) {
  auto o = owner(env, args.at(0));
  if (!TerminateJobObject(o->directory.value, 1)) fail("JOB_TERMINATE_FAILED");
  if (!TerminateJobObject(o->account.value, 1)) fail("JOB_TERMINATE_FAILED");
  return undefined(env);
}
napi_value counts(napi_env env, const std::vector<napi_value>& args) {
  auto o = owner(env, args.at(0)); napi_value result; check(napi_create_object(env, &result));
  set(env, result, "directory", number(env, active(o->directory.value))); set(env, result, "account", number(env, active(o->account.value))); return result;
}
napi_value close(napi_env env, const std::vector<napi_value>& args) {
  auto o = external<Owner>(env, args.at(0)); if (!o->directory.value) return undefined(env);
  if (active(o->directory.value) || active(o->account.value)) throw Failure("NOT_RETIRED", "Job still has active processes");
  o->account.close(); o->directory.close(); return undefined(env);
}
struct Wait {
  Handle directory, account, process;
  uint32_t timeout;
  bool retired = false;
  std::string code, error;
  napi_async_work work = nullptr;
  napi_deferred deferred;
};
void duplicate(HANDLE source, Handle& target) {
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &target.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) fail("HANDLE_DUPLICATE_FAILED");
}
void executeWait(napi_env, void* data) {
  auto wait = static_cast<Wait*>(data);
  try {
    ULONGLONG start = GetTickCount64();
    for (;;) {
      DWORD status = WaitForSingleObject(wait->process.value, 0);
      if (status == WAIT_FAILED) fail("PROCESS_WAIT_FAILED");
      if (status == WAIT_OBJECT_0 && active(wait->directory.value) == 0 && active(wait->account.value) == 0) { wait->retired = true; break; }
      ULONGLONG elapsed = GetTickCount64() - start;
      if (elapsed >= wait->timeout) break;
      Sleep(static_cast<DWORD>(std::min<ULONGLONG>(10, wait->timeout - elapsed)));
    }
  } catch (const Failure& error) { wait->code = error.code; wait->error = error.what(); }
  catch (const std::exception& error) { wait->code = "NATIVE_ERROR"; wait->error = error.what(); }
}
void completeWait(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Wait> wait(static_cast<Wait*>(data));
  if (status != napi_ok || !wait->error.empty()) {
    napi_value error, message = string(env, wait->error.empty() ? "Async wait cancelled" : wait->error);
    napi_create_error(env, string(env, wait->code.empty() ? "WAIT_CANCELLED" : wait->code), message, &error);
    napi_reject_deferred(env, wait->deferred, error);
  } else { napi_value result; napi_get_boolean(env, wait->retired, &result); napi_resolve_deferred(env, wait->deferred, result); }
  napi_delete_async_work(env, wait->work);
}
napi_value waitRetired(napi_env env, const std::vector<napi_value>& args) {
  auto o = owner(env, args.at(0)); auto p = process(env, args.at(1)); belongs(o, p);
  auto wait = std::make_unique<Wait>(); check(napi_get_value_uint32(env, args.at(2), &wait->timeout));
  duplicate(o->directory.value, wait->directory); duplicate(o->account.value, wait->account); duplicate(p->handle.value, wait->process);
  napi_value promise; check(napi_create_promise(env, &wait->deferred, &promise));
  check(napi_create_async_work(env, nullptr, string(env, "Minecraft Windows Job retirement"), executeWait, completeWait, wait.get(), &wait->work));
  napi_status status = napi_queue_async_work(env, wait->work);
  if (status != napi_ok) { napi_delete_async_work(env, wait->work); check(status); }
  wait.release(); return promise;
}
} // namespace

NAPI_MODULE_INIT() {
  const napi_property_descriptor descriptors[] = {
    {"selfIdentity", nullptr, callback<selfIdentity>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"acquire", nullptr, callback<acquire>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openProcess", nullptr, callback<openProcess>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeProcess", nullptr, callback<closeProcess>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminateProcess", nullptr, callback<terminateProcess>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"assign", nullptr, callback<assign>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, callback<terminate>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"active", nullptr, callback<counts>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"waitRetired", nullptr, callback<waitRetired>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, callback<close>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  return exports;
}
