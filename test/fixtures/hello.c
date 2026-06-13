#include <stdio.h>
#include <unistd.h>

int add(int a, int b) {
    int result = a + b;
    return result;
}

int main(int argc, char **argv) {
    // setbuf(stdout, NULL);
    printf("Hello from ARM64 robot!\n");
    int x = 10, y = 20;
    int sum = add(x, y);
    
    printf("%d + %d = %d\n", x, y, sum);

    for (int i = 0; i < 5; i++) {
        printf("Loop iteration %d\n", i);
        sleep(1);
    }

    int *p = NULL;
    *p = 42;
    return 0;
}
