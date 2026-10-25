// OS experiment helpers only: deliberately create incompatible external hierarchies.
// Production ownership has no test switches and never configures these limits.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <string>

namespace {
void finalize(napi_env, void* handle, void*) { CloseHandle(static_cast<HANDLE>(handle)); }
napi_value error(napi_env env, const char* operation) {
  std::string message = std::string(operation) + ": " + std::to_string(GetLastError());
  napi_throw_error(env, "OS_FIXTURE_FAILED", message.c_str()); return nullptr;
}
napi_value external(napi_env env, napi_callback_info) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return error(env, "CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { CloseHandle(job); return error(env, "SetInformationJobObject"); }
  if (!AssignProcessToJobObject(job, GetCurrentProcess())) { CloseHandle(job); return error(env, "External assign"); }
  napi_value result; napi_create_external(env, job, finalize, nullptr, &result); return result;
}
napi_value anchorAccount(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  size_t size = 0; napi_get_value_string_utf16(env, args[0], nullptr, 0, &size);
  std::wstring digest(size + 1, L'\0');
  napi_get_value_string_utf16(env, args[0], reinterpret_cast<char16_t*>(digest.data()), digest.size(), &size); digest.resize(size);
  HANDLE job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, (L"Global\\Uina.Minecraft.Account." + digest).c_str());
  if (!job) return error(env, "Open account Job");
  uint32_t pid; napi_get_value_uint32(env, args[1], &pid);
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  if (!process) { CloseHandle(job); return error(env, "Open anchor process"); }
  BOOL changed = AssignProcessToJobObject(job, process);
  CloseHandle(process);
  DWORD last = GetLastError(); CloseHandle(job); SetLastError(last);
  if (!changed) return error(env, "Anchor account");
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value breakaway(napi_env env, napi_callback_info) {
  wchar_t executable[32768]; GetModuleFileNameW(nullptr, executable, 32768);
  std::wstring command = L"\"" + std::wstring(executable) + L"\" -e \"process.exit(0)\"";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
  BOOL created = CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
                               CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
  DWORD code = created ? 0 : GetLastError();
  if (created) { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, INFINITE); CloseHandle(process.hThread); CloseHandle(process.hProcess); }
  napi_value result; napi_create_uint32(env, code, &result); return result;
}
}
NAPI_MODULE_INIT() {
  napi_property_descriptor descriptors[] = {
    {"external", nullptr, external, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"anchorAccount", nullptr, anchorAccount, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"breakaway", nullptr, breakaway, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, descriptors); return exports;
}
