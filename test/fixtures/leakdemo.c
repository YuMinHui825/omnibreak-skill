#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>

static void leak_once() {
    char *p = malloc(1024);
    sprintf(p, "leaked 1KB at %p", (void*)p);
    printf("[leakdemo] %s\n", p);
}

static int totalKB = 0;
static void leak_chunk() {
    size_t sz = 10240; // 10KB per leak
    char *p = malloc(sz);
    memset(p, 0xCD, sz);
    totalKB += 10;
    printf("[leakdemo] +10KB leaked, total=%d KB\n", totalKB);
}

int main() {
    printf("[leakdemo] PID=%d - leaking 10KB every 1s\n", getpid());
    while (1) { leak_chunk(); sleep(1); }
}
