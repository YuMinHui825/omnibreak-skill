#include <iostream>
#include <thread>
#include <chrono>
#include <vector>

// Simulates a slow memory leak — allocates 10KB every second without freeing
int main() {
    std::cout << "[C++ LeakDemo] Starting memory leak simulation" << std::endl;
    std::vector<char*> leaks;
    int count = 0;
    while (true) {
        char* buf = new char[10240];  // 10KB
        // touch pages to force actual allocation
        for (int i = 0; i < 10240; i += 4096) buf[i] = 1;
        leaks.push_back(buf);
        count++;
        std::cout << "[C++ LeakDemo] Allocated " << count * 10 << "KB total (" << count << " blocks)" << std::endl;
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    return 0;
}
