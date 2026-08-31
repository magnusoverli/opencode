#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define SOURCE_PATH "/homeassistant"
#define TARGET_PATH "/mnt/opencode-v2-homeassistant"
#define READY_PATH "/run/opencode-v2-homeassistant.ready"
#define USER_BUNDLE_PATH "/etc/s6-overlay/s6-rc.d/user/contents.d/"
#define RUNTIME_UID 60000
#define RUNTIME_GID 60000

extern char **environ;

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "opencode-container-init: %s: %s\n", message,
          strerror(errno));
  _exit(126);
}

static void require_directory(const char *path, uid_t uid, gid_t gid) {
  struct stat info;
  if (lstat(path, &info) != 0 || !S_ISDIR(info.st_mode) ||
      info.st_uid != uid || info.st_gid != gid) {
    errno = EINVAL;
    fail("required directory has an unsafe identity");
  }
}

static void create_idmapped_mount(void) {
  pid_t child = fork();
  if (child < 0) fail("cannot fork the mount helper");
  if (child == 0) {
    char *arguments[] = {
        "/usr/bin/mount", "--bind", "-o",
        "X-mount.idmap=b:0:60000:1,nosuid,nodev", SOURCE_PATH, TARGET_PATH,
        NULL,
    };
    execve(arguments[0], arguments, environ);
    _exit(127);
  }

  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
      WEXITSTATUS(status) != 0) {
    errno = EPERM;
    fail("cannot create the ID-mapped Home Assistant view");
  }

  struct stat source;
  struct stat target;
  if (stat(SOURCE_PATH, &source) != 0 || stat(TARGET_PATH, &target) != 0 ||
      source.st_dev != target.st_dev || source.st_ino != target.st_ino ||
      source.st_uid != 0 || source.st_gid != 0 ||
      target.st_uid != RUNTIME_UID || target.st_gid != RUNTIME_GID) {
    errno = EINVAL;
    fail("ID-mapped Home Assistant view failed verification");
  }
}

static bool v1_rollback_requested(void) {
  pid_t child = fork();
  if (child < 0) fail("cannot fork the rollback option reader");
  if (child == 0) {
    int null_fd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDOUT_FILENO) < 0 ||
        dup2(null_fd, STDERR_FILENO) < 0) {
      _exit(127);
    }
    close(null_fd);
    char *arguments[] = {
        "/usr/bin/jq", "-e", ".terminal_runtime == \"v1\"",
        "/data/options.json", NULL,
    };
    execve(arguments[0], arguments, environ);
    _exit(127);
  }

  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) {
    fail("cannot read the terminal rollback option");
  }
  if (WEXITSTATUS(status) == 0) return true;
  if (WEXITSTATUS(status) == 1) return false;
  errno = EINVAL;
  fail("terminal rollback option is invalid");
  return false;
}

static void disable_v2_services(void) {
  static const char *services[] = {
      "ha-opencode-v2-credential-broker",
      "ha-opencode-v2-mcp-proxy",
      "ha-opencode-v2-mcp-sidecar",
      "ha-opencode-v2-server",
  };
  char path[256];
  for (size_t index = 0; index < sizeof(services) / sizeof(services[0]); index++) {
    int length = snprintf(path, sizeof(path), "%s%s", USER_BUNDLE_PATH,
                          services[index]);
    if (length < 0 || (size_t)length >= sizeof(path)) {
      errno = ENAMETOOLONG;
      fail("cannot resolve a V2 service bundle entry");
    }
    if (unlink(path) != 0 && errno != ENOENT) {
      fail("cannot disable a V2 service for V1 rollback");
    }
  }
}

static void drop_sys_admin(void) {
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_LOWER, CAP_SYS_ADMIN, 0, 0) != 0 &&
      errno != EINVAL) {
    fail("cannot clear ambient SYS_ADMIN");
  }
  if (prctl(PR_CAPBSET_DROP, CAP_SYS_ADMIN, 0, 0, 0) != 0) {
    fail("cannot remove SYS_ADMIN from the bounding set");
  }

  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[2];
  if (syscall(SYS_capget, &header, data) != 0) {
    fail("cannot read the process capability sets");
  }
  unsigned int mask = ~(1U << (CAP_SYS_ADMIN % 32));
  size_t index = (size_t)(CAP_SYS_ADMIN / 32);
  data[index].effective &= mask;
  data[index].permitted &= mask;
  data[index].inheritable &= mask;
  if (syscall(SYS_capset, &header, data) != 0) {
    fail("cannot clear SYS_ADMIN from the process capability sets");
  }

  memset(data, 0, sizeof(data));
  if (syscall(SYS_capget, &header, data) != 0 ||
      (data[index].effective & ~mask) != 0 ||
      (data[index].permitted & ~mask) != 0 ||
      (data[index].inheritable & ~mask) != 0 ||
      prctl(PR_CAPBSET_READ, CAP_SYS_ADMIN, 0, 0, 0) != 0) {
    errno = EPERM;
    fail("SYS_ADMIN remained available after mount setup");
  }
}

static void publish_ready(void) {
  int fd = open(READY_PATH,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0 || fchmod(fd, 0600) != 0) {
    fail("cannot publish the ID-mapped mount marker");
  }
  static const char value[] = TARGET_PATH "\n";
  if (write(fd, value, sizeof(value) - 1) != (ssize_t)(sizeof(value) - 1) ||
      fsync(fd) != 0 || close(fd) != 0) {
    fail("cannot persist the ID-mapped mount marker");
  }
}

int main(void) {
  if (geteuid() != 0) {
    errno = EPERM;
    fail("must start as root");
  }
  require_directory(SOURCE_PATH, 0, 0);
  require_directory(TARGET_PATH, 0, 0);
  if (unlink(READY_PATH) != 0 && errno != ENOENT) {
    fail("cannot remove a stale ID-mapped mount marker");
  }
  bool rollback = v1_rollback_requested();
  if (rollback) {
    disable_v2_services();
  } else {
    create_idmapped_mount();
  }
  drop_sys_admin();
  if (!rollback) publish_ready();

  char *arguments[] = {"/init", NULL};
  execve(arguments[0], arguments, environ);
  fail("cannot execute s6 init");
}
