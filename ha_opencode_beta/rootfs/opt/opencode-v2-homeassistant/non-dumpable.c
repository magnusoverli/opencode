#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define SECRET_LENGTH 64

static void fail(void) {
  _exit(126);
}

static void read_exact(int fd, void *buffer, size_t length) {
  char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail();
    cursor += count;
    length -= (size_t)count;
  }
}

static void require_hex(const char value[SECRET_LENGTH]) {
  for (size_t index = 0; index < SECRET_LENGTH; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) {
      fail();
    }
  }
}

__attribute__((constructor)) static void harden_process(void) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail();

  const char *path = getenv("OPENCODE_V2_CREDENTIAL_SOCKET");
  if (!path) {
    unsetenv("LD_PRELOAD");
    return;
  }
  if (path[0] != '/') fail();
  int broker = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (broker < 0) fail();
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  memcpy(address.sun_path, path, strlen(path) + 1);
  if (connect(broker, (struct sockaddr *)&address, sizeof(address)) != 0) fail();

  char password[SECRET_LENGTH + 1];
  char sidecar[SECRET_LENGTH];
  unsigned char has_sidecar;
  read_exact(broker, password, SECRET_LENGTH);
  read_exact(broker, &has_sidecar, sizeof(has_sidecar));
  if (has_sidecar > 1) fail();
  if (has_sidecar) read_exact(broker, sidecar, SECRET_LENGTH);
  close(broker);
  require_hex(password);
  if (has_sidecar) require_hex(sidecar);
  password[SECRET_LENGTH] = '\0';
  if (setenv("OPENCODE_SERVER_PASSWORD", password, 1) != 0) fail();
  explicit_bzero(password, sizeof(password));

  if (has_sidecar) {
    int descriptors[2];
    if (pipe2(descriptors, O_CLOEXEC) != 0) fail();
    size_t written = 0;
    while (written < SECRET_LENGTH) {
      ssize_t count = write(descriptors[1], sidecar + written, SECRET_LENGTH - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) fail();
      written += (size_t)count;
    }
    close(descriptors[1]);
    if (descriptors[0] != 3) {
      if (dup3(descriptors[0], 3, 0) != 3) fail();
      close(descriptors[0]);
    } else if (fcntl(3, F_SETFD, 0) != 0) {
      fail();
    }
  } else {
    close(3);
  }
  explicit_bzero(sidecar, sizeof(sidecar));
  unsetenv("OPENCODE_V2_CREDENTIAL_SOCKET");
  unsetenv("LD_PRELOAD");
}
