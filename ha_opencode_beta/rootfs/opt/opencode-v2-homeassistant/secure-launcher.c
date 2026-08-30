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

#define RUNTIME_UID 60000
#define RUNTIME_GID 60000

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
                            const char *cache_home,
                            const char *credential_socket_leaf) {
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
  join_path(credential_socket, runtime_root, credential_socket_leaf);

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
  SET_ENV("USER", "opencode-v2");
  SET_ENV("LOGNAME", "opencode-v2");
  SET_ENV("SHELL", "/bin/bash");
  SET_ENV("PATH", "/usr/local/bin:/usr/bin:/bin");
  SET_ENV("LANG", "C.UTF-8");
  SET_ENV("TERM", "xterm-256color");
  SET_ENV("COLORTERM", "truecolor");
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

static void publish_expected_client(const char *runtime_root) {
  char clients[PATH_MAX];
  join_path(clients, runtime_root, "clients");
  char temporary[PATH_MAX];
  char destination[PATH_MAX];
  if (snprintf(temporary, sizeof(temporary), "%s/.%ld", clients, (long)getpid()) >= PATH_MAX ||
      snprintf(destination, sizeof(destination), "%s/%ld", clients, (long)getpid()) >= PATH_MAX) {
    fail("client identity path is too long");
  }
  unlink(temporary);
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0 || fchmod(fd, 0600) != 0) fail("cannot publish the client process identity");
  char text[96];
  int length = snprintf(text, sizeof(text), "%ld %llu\n", (long)getpid(), process_start_time(getpid()));
  if (length < 4 || write(fd, text, (size_t)length) != length || fsync(fd) != 0 ||
      close(fd) != 0 || rename(temporary, destination) != 0) {
    fail("cannot publish the client process identity");
  }
}

static void drop_privileges(void) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail("cannot establish the process security policy");
  }

  for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) {
      fail("cannot clear the capability bounding set");
    }
  }
  if (setgroups(0, NULL) != 0 ||
      setresgid(RUNTIME_GID, RUNTIME_GID, RUNTIME_GID) != 0 ||
      setresuid(RUNTIME_UID, RUNTIME_UID, RUNTIME_UID) != 0) {
    fail("cannot switch to the runtime identity");
  }

  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, capabilities) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 || getuid() != RUNTIME_UID ||
      geteuid() != RUNTIME_UID || getgid() != RUNTIME_GID ||
      getegid() != RUNTIME_GID || getgroups(0, NULL) != 0) {
    fail("cannot finalize the runtime process boundary");
  }
}

int main(int argc, char **argv) {
  int client_mode = argc >= 2 && strcmp(argv[1], "--client") == 0;
  int client_probe = client_mode && argc == 6 && strcmp(argv[5], "--probe") == 0;
  if ((!client_mode && argc != 5) ||
      (client_mode && !((argc == 5) || client_probe))) {
    fail("expected server launch arguments or --client runtime-root generation-root cache-home [--probe]");
  }

  const char *runtime_root = client_mode ? argv[2] : argv[1];
  const char *generation_root = client_mode ? argv[3] : argv[2];
  const char *cache_home = client_mode ? argv[4] : argv[3];

  char *end = NULL;
  long port = 0;
  if (!client_mode) {
    errno = 0;
    port = strtol(argv[4], &end, 10);
    if (errno != 0 || end == argv[4] || *end != '\0' || port < 1 ||
        port > 65535) {
      fail("server port is invalid");
    }
  }

  char workspace[PATH_MAX];
  join_path(workspace, runtime_root, "workspace");
  close(3);
  if (chdir(workspace) != 0) {
    fail("cannot enter the secured runtime workspace");
  }

  if (client_mode) publish_expected_client(runtime_root);
  else publish_expected_pid(runtime_root);
  set_environment(runtime_root, generation_root, cache_home,
                  client_mode ? "client-credential.sock" : "credential.sock");
  drop_privileges();

  if (client_mode) {
    if (client_probe) {
      char *child_argv[] = {
          "/usr/local/bin/opencode2", "api", "--server",
          "http://127.0.0.1:4100", "GET", "/api/health", NULL,
      };
      execve(child_argv[0], child_argv, environ);
    } else {
      char *child_argv[] = {
          "/usr/local/bin/opencode2", "--server", "http://127.0.0.1:4100",
          workspace, NULL,
      };
      execve(child_argv[0], child_argv, environ);
    }
    fail("cannot execute the pinned OpenCode V2 client");
  }

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
