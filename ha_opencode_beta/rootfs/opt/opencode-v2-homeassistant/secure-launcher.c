#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "opencode-v2-launch: %s\n", message);
  _exit(126);
}

static void join_path(char output[PATH_MAX], const char *root,
                      const char *leaf) {
  if (snprintf(output, PATH_MAX, "%s/%s", root, leaf) >= PATH_MAX) {
    fail("runtime path is too long");
  }
}

static void set_environment(const char *runtime_root,
                            const char *generation_root,
                            const char *cache_home) {
  char home[PATH_MAX];
  char config[PATH_MAX];
  char data[PATH_MAX];
  char state[PATH_MAX];
  char managed[PATH_MAX];
  char credential_socket[PATH_MAX];
  join_path(home, runtime_root, "home");
  join_path(config, runtime_root, "config");
  join_path(data, generation_root, "data");
  join_path(state, generation_root, "state");
  join_path(managed, runtime_root, "managed.json");
  join_path(credential_socket, runtime_root, "credential.sock");

  if (clearenv() != 0) {
    fail("cannot clear the inherited environment");
  }

#define SET_ENV(name, value)                                                   \
  do {                                                                         \
    if (setenv((name), (value), 1) != 0) {                                     \
      fail("cannot construct the runtime environment");                       \
    }                                                                          \
  } while (0)

  SET_ENV("HOME", home);
  SET_ENV("USER", "root");
  SET_ENV("LOGNAME", "root");
  SET_ENV("SHELL", "/bin/bash");
  SET_ENV("PATH", "/usr/local/bin:/usr/bin:/bin");
  SET_ENV("LANG", "C.UTF-8");
  SET_ENV("NODE_OPTIONS", "--max-old-space-size=512");
  SET_ENV("TMPDIR", cache_home);
  SET_ENV("XDG_CONFIG_HOME", config);
  SET_ENV("XDG_DATA_HOME", data);
  SET_ENV("XDG_STATE_HOME", state);
  SET_ENV("XDG_CACHE_HOME", cache_home);
  SET_ENV("OPENCODE_CONFIG", managed);
  SET_ENV("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
  SET_ENV("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1");
  SET_ENV("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "1");
  SET_ENV("OPENCODE_DISABLE_AUTOUPDATE", "true");
  SET_ENV("OPENCODE_SERVER_USERNAME", "opencode");
  SET_ENV("OPENCODE_V2_CREDENTIAL_SOCKET", credential_socket);
  SET_ENV("LD_PRELOAD", "/usr/local/lib/opencode-v2-non-dumpable.so");
#undef SET_ENV
}

static unsigned long long process_start_time(pid_t pid) {
  char path[64];
  if (snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid) >= (int)sizeof(path)) {
    fail("cannot resolve the process identity");
  }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail("cannot inspect the process identity");
  char text[4096];
  ssize_t count = read(fd, text, sizeof(text) - 1);
  close(fd);
  if (count <= 0) fail("cannot inspect the process identity");
  text[count] = '\0';

  char *cursor = strrchr(text, ')');
  if (!cursor || cursor[1] != ' ') fail("cannot parse the process identity");
  cursor += 2;
  char *save = NULL;
  char *token = strtok_r(cursor, " \n", &save);
  for (int field = 3; token && field < 22; field++) {
    token = strtok_r(NULL, " \n", &save);
  }
  if (!token) fail("cannot parse the process identity");
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(token, &end, 10);
  if (errno != 0 || end == token || *end != '\0') {
    fail("cannot parse the process identity");
  }
  return value;
}

static void publish_expected_pid(const char *runtime_root) {
  char temporary[PATH_MAX];
  char destination[PATH_MAX];
  join_path(temporary, runtime_root, ".v2.pid");
  join_path(destination, runtime_root, "v2.pid");
  int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0 || fchmod(fd, 0600) != 0) fail("cannot publish the runtime process identity");
  char text[96];
  int length = snprintf(text, sizeof(text), "%ld %llu\n", (long)getpid(),
                        process_start_time(getpid()));
  if (length < 4 || write(fd, text, (size_t)length) != length || fsync(fd) != 0 ||
      close(fd) != 0 || rename(temporary, destination) != 0) {
    fail("cannot publish the runtime process identity");
  }
}

static void enter_workspace(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat workspace;
  struct stat project_config;
  if (path[0] != '/' || fd < 0 || fstat(fd, &workspace) != 0 ||
      workspace.st_uid != 0 || workspace.st_gid != 0 ||
      (workspace.st_mode & 0777) != 0755) {
    if (fd >= 0) close(fd);
    fail("cannot open the root-owned V2 project workspace");
  }
  if (fstatat(fd, ".opencode", &project_config, AT_SYMLINK_NOFOLLOW) == 0) {
    close(fd);
    fail("project .opencode content is not allowed in the V2 server");
  }
  if (errno != ENOENT || fchdir(fd) != 0) {
    close(fd);
    fail("cannot verify project plugin isolation");
  }
  close(fd);
}

static void harden_process(void) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      getuid() != 0 || geteuid() != 0 || getgid() != 0 || getegid() != 0) {
    fail("cannot establish the process security policy");
  }
}

int main(int argc, char **argv) {
  if (argc != 6) {
    fail("expected runtime-root, generation-root, cache-home, port, and workspace");
  }

  char *end = NULL;
  errno = 0;
  long port = strtol(argv[4], &end, 10);
  if (errno != 0 || end == argv[4] || *end != '\0' || port < 1 ||
      port > 65535) {
    fail("server port is invalid");
  }

  close(3);
  enter_workspace(argv[5]);

  publish_expected_pid(argv[1]);
  set_environment(argv[1], argv[2], argv[3]);
  harden_process();

  char port_text[6];
  snprintf(port_text, sizeof(port_text), "%ld", port);
  char *child_argv[] = {
      "/usr/local/bin/opencode2", "serve",      "--hostname",
      "127.0.0.1",                  "--port",     port_text,
      "--print-logs",               "--log-level", "info",
      NULL,
  };
  execve(child_argv[0], child_argv, environ);
  fail("cannot execute the pinned OpenCode V2 runtime");
}
