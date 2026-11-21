#pragma once

// The HTTP server: uWebSockets, adapted to http::Service.
//
// A server has one or more listeners, each on its own port with its own
// service (the S3 API and the web UI). All listeners share one event loop on
// the calling thread, so the services are only ever called from that thread.
//
// Each request's body is streamed to its Exchange chunk by chunk. Every
// response carries x-amz-request-id. Responses to HEAD, and 204 and 304
// responses, are sent without a body.

#include "micros3/http.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <vector>

namespace micros3 {

class Server {
public:
    // A server with one listener.
    explicit Server(http::Service &service) : services_{&service} {}
    // A server with one listener per service, in order.
    explicit Server(std::vector<http::Service *> services);

    // Listens on `port` (0 picks a free port) and runs the event loop on the
    // calling thread until stop() is called. `on_listen` is called once with
    // the bound port, or 0 when listening failed. Returns false when
    // listening failed. For a server with one listener.
    bool run(std::uint16_t port, const std::function<void(int)> &on_listen);

    // Listens on `ports[i]` for `services[i]` and runs the event loop until
    // stop() is called. `on_listen` is called once with the bound port of
    // each listener, or 0 for each one that failed. If any listener fails,
    // none is served and run() returns false. Throws std::invalid_argument
    // when the number of ports differs from the number of services.
    bool run(const std::vector<std::uint16_t> &ports,
             const std::function<void(const std::vector<int> &)> &on_listen);

    // Stops a running server, closing every connection. Thread-safe. When
    // called before run() has started, run() returns as soon as it listens.
    void stop();

private:
    std::vector<http::Service *> services_;
    std::atomic<void *> loop_{nullptr};
    std::atomic<bool> stop_requested_{false};
    std::function<void()> close_;
};

} // namespace micros3
