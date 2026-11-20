#include "micros3/server.h"

#include <App.h>

#include <cctype>
#include <exception>
#include <iostream>
#include <memory>
#include <string>

namespace micros3 {

namespace {

// Per-request state shared by the uWS callbacks.
struct Pending {
    std::unique_ptr<http::Exchange> exchange;
    std::string method;
    std::string path;
    std::string request_id;
    bool aborted = false;
};

http::Response internal_error(const Pending &pending) {
    http::Request request;
    request.path = pending.path;
    request.request_id = pending.request_id;
    return http::error_response(
        S3Error{500, "InternalError", "We encountered an internal error. Please try again."}, request);
}

template <typename Res>
void send(Res *res, const http::Response &response, const Pending &pending) {
    const std::string status = std::to_string(response.status) + " " + std::string(http::reason(response.status));
    res->cork([&] {
        res->writeStatus(status);
        res->writeHeader("x-amz-request-id", pending.request_id);
        for (const auto &[name, value] : response.headers) {
            // uWS writes Content-Length itself.
            if (name == "Content-Length" || name == "content-length") continue;
            res->writeHeader(name, value);
        }
        if (http::bodyless(pending.method, response.status)) {
            const bool reports_length = response.status != 204 && response.status != 304 &&
                                        (response.status < 100 || response.status >= 200);
            if (reports_length && response.reported_length) {
                res->endWithoutBody(static_cast<std::size_t>(*response.reported_length));
            } else {
                res->endWithoutBody();
            }
        } else {
            res->end(response.body);
        }
    });
}

} // namespace

bool Server::run(std::uint16_t port, const std::function<void(int)> &on_listen) {
    uWS::App app;
    app.any("/*", [this](auto *res, auto *req) {
        http::Request request;
        std::string method(req->getCaseSensitiveMethod());
        for (char &c : method) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        request.method = method;
        request.path = std::string(req->getUrl());
        request.query = std::string(req->getQuery());
        for (auto [name, value] : *req) {
            request.headers.emplace_back(std::string(name), std::string(value));
        }
        request.request_id = http::new_request_id();

        auto pending = std::make_shared<Pending>();
        pending->method = request.method;
        pending->path = request.path;
        pending->request_id = request.request_id;
        try {
            pending->exchange = service_.begin(request);
        } catch (const std::exception &e) {
            std::cerr << "Request " << request.request_id << " failed: " << e.what() << std::endl;
        }

        res->onAborted([pending] {
            pending->aborted = true;
            if (pending->exchange) pending->exchange->on_abort();
            pending->exchange.reset();
        });
        res->onData([pending, res](std::string_view chunk, bool last) {
            if (pending->aborted) return;
            try {
                if (pending->exchange && !chunk.empty()) pending->exchange->on_data(chunk);
                if (!last) return;
                http::Response response = pending->exchange ? pending->exchange->on_end() : internal_error(*pending);
                pending->exchange.reset();
                send(res, response, *pending);
            } catch (const std::exception &e) {
                std::cerr << "Request " << pending->request_id << " failed: " << e.what() << std::endl;
                if (pending->exchange) pending->exchange->on_abort();
                pending->exchange.reset();
                if (last) {
                    send(res, internal_error(*pending), *pending);
                } else {
                    // The body cannot be skipped safely; drop the connection.
                    pending->aborted = true;
                    res->close();
                }
            }
        });
    });

    us_listen_socket_t *listen_socket = nullptr;
    app.listen(port, [&listen_socket](us_listen_socket_t *socket) { listen_socket = socket; });
    if (listen_socket == nullptr) {
        on_listen(0);
        return false;
    }
    const int bound = us_socket_local_port(0, reinterpret_cast<us_socket_t *>(listen_socket));

    bool closed = false;
    close_ = [&app, &closed] {
        if (!closed) {
            closed = true;
            app.close();
        }
    };
    loop_.store(uWS::Loop::get());
    on_listen(bound);
    if (stop_requested_.load()) close_();
    app.run();
    loop_.store(nullptr);
    close_ = nullptr;
    return true;
}

void Server::stop() {
    stop_requested_.store(true);
    if (auto *loop = static_cast<uWS::Loop *>(loop_.load())) {
        loop->defer([this] {
            if (close_) close_();
        });
    }
}

} // namespace micros3
