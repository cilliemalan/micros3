#include "micros3/hello.h"

#include <App.h>

#include <iostream>

int main() {
    bool listening = false;
    uWS::App()
        .get("/", [](auto *response, auto *) {
            response->writeHeader("Content-Type", "text/plain; charset=utf-8")
                ->end(micros3::hello());
        })
        .listen(3000, [&listening](auto *socket) {
            listening = socket != nullptr;
            if (listening) {
                std::cout << "Listening on port 3000" << std::endl;
            } else {
                std::cerr << "Failed to listen on port 3000" << std::endl;
            }
        })
        .run();
    return listening ? 0 : 1;
}
