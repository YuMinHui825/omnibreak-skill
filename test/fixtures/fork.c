#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    setbuf(stdout, NULL);
    printf("[Parent] pid=%d forking...\n", getpid());
    pid_t pid = fork();
    if (pid == 0) {
        printf("[Child] pid=%d running loop\n", getpid());
        for (int i = 0; i < 4; i++) {
            printf("[Child] iteration %d\n", i);
            usleep(200000);
        }
        printf("[Child] done\n");
        _exit(0);
    }
    printf("[Parent] waiting for child\n");
    wait(NULL);
    printf("[Parent] all done\n");
    return 0;
}
