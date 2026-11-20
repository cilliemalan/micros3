#include "micros3/config.h"

#include "micros3/server.h"
#include "micros3/service.h"
#include "micros3/store.h"

#include <exception>
#include <memory>

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

    std::unique_ptr<micros3::Store> store;
    try {
        store = std::make_unique<micros3::Store>(cfg.data_dir);
    } catch (const std::exception &e) {
        std::cerr << program << ": cannot open data directory " << cfg.data_dir << ": " << e.what() << std::endl;
        return 1;
    }
    const micros3::StartupScan &scan = store->startup_scan();
    if (scan.staging_removed != 0 || scan.orphan_blobs_removed != 0) {
        std::cout << "Startup scan removed " << scan.staging_removed << " staging file(s) and "
                  << scan.orphan_blobs_removed << " unreferenced blob(s)" << std::endl;
    }

    micros3::S3Service service;
    micros3::Server server(service);
    const bool listening = server.run(cfg.port, [&cfg](int port) {
        if (port != 0) {
            std::cout << "Listening on port " << port << " with data directory " << cfg.data_dir << std::endl;
        } else {
            std::cerr << "Failed to listen on port " << cfg.port << std::endl;
        }
    });
    return listening ? 0 : 1;
}
