#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define RUNTIME_UID 0
#define SECRET_LENGTH 64

static int listener = -1;
static char socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "opencode-v2-credential-broker: %s\n", message);
  exit(126);
}

static void cleanup(int signal_number) {
  if (listener >= 0) close(listener);
  if (socket_path[0] != '\0') unlink(socket_path);
  _exit(signal_number == 0 ? 0 : 128 + signal_number);
}

static int open_root_secret(const char *path, int optional) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 && optional && errno == ENOENT) return -1;
  if (fd < 0) return -2;

  struct stat status;
  if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_uid != 0 || status.st_gid != 0 ||
      (status.st_mode & 07777) != 0600 || status.st_nlink != 1) {
    close(fd);
    return -2;
  }
  return fd;
}

static int read_hex_secret(int fd, char output[SECRET_LENGTH]) {
  ssize_t total = 0;
  while (total < SECRET_LENGTH) {
    ssize_t count = pread(fd, output + total, SECRET_LENGTH - total, total);
    if (count <= 0) return -1;
    total += count;
  }
  char extra;
  if (pread(fd, &extra, 1, SECRET_LENGTH) != 0) return -1;
  for (size_t index = 0; index < SECRET_LENGTH; index++) {
    if (!((output[index] >= '0' && output[index] <= '9') ||
          (output[index] >= 'a' && output[index] <= 'f'))) {
      return -1;
    }
  }
  return 0;
}

static int read_process_start_time(pid_t pid, unsigned long long *start_time) {
  char path[64];
  if (snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid) >= (int)sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  char text[4096];
  ssize_t count = read(fd, text, sizeof(text) - 1);
  close(fd);
  if (count <= 0) return -1;
  text[count] = '\0';
  char *cursor = strrchr(text, ')');
  if (!cursor || cursor[1] != ' ') return -1;
  cursor += 2;
  char *save = NULL;
  char *token = strtok_r(cursor, " \n", &save);
  for (int field = 3; token && field < 22; field++) token = strtok_r(NULL, " \n", &save);
  if (!token) return -1;
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(token, &end, 10);
  if (errno != 0 || end == token || *end != '\0') return -1;
  *start_time = value;
  return 0;
}

static int validate_expected_identity(const char *path, pid_t pid) {
  int fd = open_root_secret(path, 0);
  if (fd < 0) return -1;
  char actual[96] = {0};
  ssize_t count = read(fd, actual, sizeof(actual) - 1);
  close(fd);
  if (count <= 0) return -1;
  unsigned long long start_time;
  if (read_process_start_time(pid, &start_time) != 0) return -1;
  char expected[96];
  int length = snprintf(expected, sizeof(expected), "%ld %llu\n", (long)pid, start_time);
  return length > 0 && count == length && memcmp(actual, expected, (size_t)length) == 0 ? 0 : -1;
}

static int write_all(int fd, const void *buffer, size_t length) {
  const char *cursor = buffer;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static void serve_client(int client, const char *runtime_root) {
  struct ucred peer;
  socklen_t peer_length = sizeof(peer);
  if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &peer_length) != 0 ||
      peer.uid != RUNTIME_UID) {
    return;
  }

  char pid_path[256];
  char password_path[256];
  char sidecar_path[256];
  if (snprintf(password_path, sizeof(password_path), "%s/server-password", runtime_root) >= (int)sizeof(password_path) ||
      snprintf(sidecar_path, sizeof(sidecar_path), "%s/sidecar-secret", runtime_root) >= (int)sizeof(sidecar_path)) {
    return;
  }

  if (snprintf(pid_path, sizeof(pid_path), "%s/v2.pid", runtime_root) >= (int)sizeof(pid_path) ||
      validate_expected_identity(pid_path, peer.pid) != 0) return;

  int password_fd = open_root_secret(password_path, 0);
  int sidecar_fd = open_root_secret(sidecar_path, 1);
  if (password_fd < 0 || sidecar_fd == -2) {
    if (password_fd >= 0) close(password_fd);
    if (sidecar_fd >= 0) close(sidecar_fd);
    return;
  }

  char password[SECRET_LENGTH];
  char sidecar[SECRET_LENGTH];
  unsigned char has_sidecar = sidecar_fd >= 0 ? 1 : 0;
  int valid = read_hex_secret(password_fd, password) == 0 &&
              (!has_sidecar || read_hex_secret(sidecar_fd, sidecar) == 0);
  close(password_fd);
  if (sidecar_fd >= 0) close(sidecar_fd);
  if (!valid) {
    explicit_bzero(password, sizeof(password));
    explicit_bzero(sidecar, sizeof(sidecar));
    return;
  }

  if (write_all(client, password, sizeof(password)) == 0 &&
      write_all(client, &has_sidecar, sizeof(has_sidecar)) == 0 &&
      (!has_sidecar || write_all(client, sidecar, sizeof(sidecar)) == 0)) {
    unlink(pid_path);
  }
  explicit_bzero(password, sizeof(password));
  explicit_bzero(sidecar, sizeof(sidecar));
}

int main(int argc, char **argv) {
  if (argc != 2) fail("expected one secured runtime root");
  if (snprintf(socket_path, sizeof(socket_path), "%s/credential.sock", argv[1]) >=
      (int)sizeof(socket_path)) {
    fail("credential socket path is too long");
  }

  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    fail("cannot establish the broker process boundary");
  }
  signal(SIGTERM, cleanup);
  signal(SIGINT, cleanup);
  signal(SIGPIPE, SIG_IGN);
  unlink(socket_path);

  listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) fail("cannot create credential socket");
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(socket_path, 0666) != 0 || listen(listener, 16) != 0) {
    close(listener);
    listener = -1;
    unlink(socket_path);
    fail("cannot bind credential socket");
  }

  for (;;) {
    int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0 && errno == EINTR) continue;
    if (client < 0) fail("cannot accept credential client");
    serve_client(client, argv[1]);
    close(client);
  }
}
