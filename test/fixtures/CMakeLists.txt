cmake_minimum_required(VERSION 3.16)
project(RobotDebugExample C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_FLAGS_DEBUG "-Og -g -ggdb3 -fno-omit-frame-pointer")

add_executable(hello src/hello.c)
add_executable(multithread src/multithread.c)
target_link_libraries(multithread pthread)

add_executable(e2e src/e2e.c)

add_library(demo SHARED src/libdemo.c)
add_executable(host src/host.c)
target_link_libraries(host demo pthread)

add_executable(leakdemo src/leakdemo.c)
