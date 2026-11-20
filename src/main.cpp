#include "micros3/config.h"

#include <App.h>

#include <iostream>
#include <string>
#include <variant>

int main(int argc, char **argv) {
    namespace config = micros3::config;
    const std::string program = argc > 0 && argv[0] != nullptr ? argv[0] : "micros3";

    config::ParseResult parsed = config::parse(argc, argv);
    if (std::holds_alternative<config::HelpRequested>(parsed)) {
        std::cout << config::usage(program);
        return 0;
    }
    if (auto *error = std::get_if<config::UsageError>(&parsed)) {
        std::cerr << program << ": " << error->message << "\n\n" << config::usage(program);
        return 2;
    }
    const config::Config cfg = std::get<config::Config>(parsed);

    bool listening = false;
    uWS::App()
        .any("/*", [](auto *response, auto *) {
            // Routing and S3 operations are not implemented yet.
            response->writeStatus("501 Not Implemented")
                ->writeHeader("Content-Type", "text/plain; charset=utf-8")
                ->end("Not implemented\n");
        })
        .listen(cfg.port, [&listening, &cfg](auto *socket) {
            listening = socket != nullptr;
            if (listening) {
                std::cout << "Listening on port " << cfg.port << " with data directory "
                          << cfg.data_dir << std::endl;
            } else {
                std::cerr << "Failed to listen on port " << cfg.port << std::endl;
            }
        })
        .run();
    return listening ? 0 : 1;
}
