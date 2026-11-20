#pragma once

// The HTTP server: uWebSockets, adapted to http::Service.
//
// Each request's body is streamed to its Exchange chunk by chunk. Every
// response carries x-amz-request-id. Responses to HEAD, and 204 and 304
// responses, are sent without a body.

#include "micros3/http.h"

#include <atomic>
#include <cstdint>
#include <functional>

namespace micros3 {

class Server {
public:
    explicit Server(http::Service &service) : service_(service) {}

    // Listens on `port` (0 picks a free port) and runs the event loop on the
    // calling thread until stop() is called. `on_listen` is called once with
    // the bound port, or 0 when listening failed. Returns false when
    // listening failed.
    bool run(std::uint16_t port, const std::function<void(int)> &on_listen);

    // Stops a running server, closing every connection. Thread-safe. When
    // called before run() has started, run() returns as soon as it listens.
    void stop();

private:
    http::Service &service_;
    std::atomic<void *> loop_{nullptr};
    std::atomic<bool> stop_requested_{false};
    std::function<void()> close_;
};

} // namespace micros3
