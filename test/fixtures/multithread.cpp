#include <iostream>
#include <thread>
#include <vector>
#include <chrono>
#include <atomic>

#define NUM_WORKERS 3

void worker(int id, int iterations) {
    std::cout << "[Thread " << id << "] Starting worker, " << iterations << " iterations" << std::endl;
    for (int i = 0; i < iterations; i++) {
        std::cout << "[Thread " << id << "] iteration " << i << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    std::cout << "[Thread " << id << "] Done" << std::endl;
}

int main() {
    std::cout << "[Main] Starting multi-thread C++ test" << std::endl;
    std::vector<std::thread> threads;
    for (int i = 0; i < NUM_WORKERS; i++) {
        threads.emplace_back(worker, i + 1, i * 4 + 4);
        std::cout << "[Main] Created thread " << i + 1 << std::endl;
    }
    for (auto& t : threads) {
        t.join();
    }
    std::cout << "[Main] All done" << std::endl;
    return 0;
}
