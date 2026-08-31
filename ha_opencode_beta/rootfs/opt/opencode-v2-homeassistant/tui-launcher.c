#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#define RUNTIME_UID 60001
#define RUNTIME_GID 60001
#define SERVER_URL "http://127.0.0.1:4100"
#define NON_DUMPABLE_LIBRARY "/usr/local/lib/opencode-v2-non-dumpable.so"
#define PASSWORD_LIMIT 1024

extern char **environ;

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "opencode-v2-tui-launch: %s\n", message);
  _exit(126);
}

static void join_path(char output[PATH_MAX], const char *root,
                      const char *leaf) {
  if (snprintf(output, PATH_MAX, "%s/%s", root, leaf) >= PATH_MAX) {
    fail("runtime path is too long");
  }
}

static void require_file(const char *path, uid_t uid, mode_t mode) {
  struct stat info;
  if (lstat(path, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != uid || info.st_nlink != 1 ||
      (info.st_mode & 0777) != mode) {
    fail("required runtime file has an unsafe identity");
  }
}

static void require_directory(const char *path, uid_t uid, gid_t gid,
                              mode_t mode) {
  struct stat info;
  if (lstat(path, &info) != 0 || !S_ISDIR(info.st_mode) ||
      info.st_uid != uid || info.st_gid != gid ||
      (info.st_mode & 0777) != mode) {
    fail("required runtime directory has an unsafe identity");
  }
}

static void reject_project_plugins(const char *path) {
  int workspace = open(path,
                       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (workspace < 0) fail("cannot open the Home Assistant workspace");
  struct stat info;
  if (fstatat(workspace, ".opencode", &info, AT_SYMLINK_NOFOLLOW) == 0) {
    close(workspace);
    fail("project .opencode content is not allowed in the V2 terminal");
  }
  if (errno != ENOENT) {
    close(workspace);
    fail("cannot verify project plugin isolation");
  }
  close(workspace);
}

static void set_environment(const char *runtime_root, const char *password,
                            const char *term, const char *colorterm) {
  char home[PATH_MAX];
  char config[PATH_MAX];
  char data[PATH_MAX];
  char state[PATH_MAX];
  char cache[PATH_MAX];
  char managed_config[PATH_MAX];
  join_path(home, runtime_root, "tui/home");
  join_path(config, runtime_root, "tui/config");
  join_path(data, runtime_root, "tui/data");
  join_path(state, runtime_root, "tui/state");
  join_path(cache, runtime_root, "tui/cache");
  join_path(managed_config, runtime_root, "tui/config/opencode/opencode.json");

  if (clearenv() != 0) fail("cannot clear the inherited environment");
#define SET_ENV(name, value)                                                   \
  do {                                                                         \
    if (setenv((name), (value), 1) != 0) {                                     \
      fail("cannot construct the TUI environment");                           \
    }                                                                          \
  } while (0)
  SET_ENV("HOME", home);
  SET_ENV("USER", "opencode-v2");
  SET_ENV("LOGNAME", "opencode-v2");
  SET_ENV("SHELL", "/usr/sbin/nologin");
  SET_ENV("PATH", "/usr/local/bin:/usr/bin:/bin");
  SET_ENV("LANG", "C.UTF-8");
  SET_ENV("TMPDIR", cache);
  SET_ENV("XDG_CONFIG_HOME", config);
  SET_ENV("XDG_DATA_HOME", data);
  SET_ENV("XDG_STATE_HOME", state);
  SET_ENV("XDG_CACHE_HOME", cache);
  SET_ENV("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
  SET_ENV("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1");
  SET_ENV("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "1");
  SET_ENV("OPENCODE_DISABLE_AUTOUPDATE", "true");
  SET_ENV("OPENCODE_CONFIG", managed_config);
  SET_ENV("OPENCODE_PASSWORD", password);
  SET_ENV("LD_PRELOAD", NON_DUMPABLE_LIBRARY);
  if (term && *term) SET_ENV("TERM", term);
  if (colorterm && *colorterm) SET_ENV("COLORTERM", colorterm);
#undef SET_ENV
}

static void drop_privileges(void) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    fail("cannot establish the TUI process security policy");
  }
  for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) {
      fail("cannot clear the TUI capability bounding set");
    }
  }
  if (setgroups(0, NULL) != 0 ||
      setresgid(RUNTIME_GID, RUNTIME_GID, RUNTIME_GID) != 0 ||
      setresuid(RUNTIME_UID, RUNTIME_UID, RUNTIME_UID) != 0) {
    fail("cannot switch to the TUI runtime identity");
  }
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, capabilities) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      getuid() != RUNTIME_UID || geteuid() != RUNTIME_UID ||
      getgid() != RUNTIME_GID || getegid() != RUNTIME_GID ||
      getgroups(0, NULL) != 0) {
    fail("cannot finalize the TUI process boundary");
  }
}

int main(int argc, char **argv) {
  if (argc != 2 || geteuid() != 0) {
    fail("expected one runtime-root argument and root execution");
  }
  char ready[PATH_MAX];
  char password_path[PATH_MAX];
  char tui_root[PATH_MAX];
  char tui_config[PATH_MAX];
  char managed_config[PATH_MAX];
  char workspace[PATH_MAX];
  join_path(ready, argv[1], "ready");
  join_path(password_path, argv[1], "server-password");
  join_path(tui_root, argv[1], "tui");
  join_path(tui_config, argv[1], "tui/config/opencode");
  join_path(managed_config, argv[1], "tui/config/opencode/opencode.json");
  join_path(workspace, argv[1], "workspace");
  require_file("/run/opencode-v2-homeassistant.ready", 0, 0600);
  require_file(ready, 0, 0600);
  require_file(password_path, 0, 0600);
  require_directory(workspace, 0, 0, 0755);
  require_directory(tui_root, 0, 0, 0755);
  require_directory(tui_config, 0, 0, 0755);
  require_file(managed_config, 0, 0444);
  reject_project_plugins(workspace);

  int password_fd = open(password_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (password_fd < 0) fail("cannot open the V2 server password");
  char password[PASSWORD_LIMIT + 1];
  ssize_t length = read(password_fd, password, PASSWORD_LIMIT + 1);
  close(password_fd);
  if (length <= 0 || length > PASSWORD_LIMIT) fail("V2 server password has an invalid length");
  while (length > 0 && (password[length - 1] == '\n' || password[length - 1] == '\r')) {
    password[--length] = '\0';
  }
  if (length == 0) fail("V2 server password is empty");
  password[length] = '\0';

  char *term = getenv("TERM") ? strdup(getenv("TERM")) : NULL;
  char *colorterm = getenv("COLORTERM") ? strdup(getenv("COLORTERM")) : NULL;
  if (chdir(workspace) != 0) fail("cannot enter the root-owned V2 project workspace");
  set_environment(argv[1], password, term, colorterm);
  explicit_bzero(password, sizeof(password));
  free(term);
  free(colorterm);
  drop_privileges();

  char *child_argv[] = {
      "/usr/local/bin/opencode2", "--server", SERVER_URL, NULL,
  };
  execve(child_argv[0], child_argv, environ);
  fail("cannot execute the pinned OpenCode V2 TUI");
}
