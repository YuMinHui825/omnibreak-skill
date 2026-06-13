#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>

#define NUM_WORKERS 3

typedef struct {
    int id;
    int iterations;
} worker_arg_t;

void *worker(void *arg) {
    worker_arg_t *w = (worker_arg_t *)arg;
    printf("[Thread %d] Starting worker, %d iterations\n", w->id, w->iterations);
    for (int i = 0; i < w->iterations; i++) {
        printf("[Thread %d] iteration %d\n", w->id, i);
        usleep(500000);
    }
    printf("[Thread %d] Done\n", w->id);
    return NULL;
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL);
    printf("[Main] Starting multi-thread test (ARM64)\n");
    pthread_t threads[NUM_WORKERS];
    worker_arg_t args[NUM_WORKERS];

    for (int i = 0; i < NUM_WORKERS; i++) {
        args[i].id = i + 1;
        args[i].iterations = i * 4 + 4;
        pthread_create(&threads[i], NULL, worker, &args[i]);
        printf("[Main] Created thread %d\n", i + 1);
    }

    printf("[Main] Waiting for workers...\n");
    for (int i = 0; i < NUM_WORKERS; i++) {
        pthread_join(threads[i], NULL);
        printf("[Main] Thread %d joined\n", i + 1);
    }

    printf("[Main] All done\n");
    return 0;
}
