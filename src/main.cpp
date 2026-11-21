#include "micros3/config.h"

#include "micros3/server.h"
#include "micros3/service.h"
#include "micros3/store.h"
#include "micros3/ui_api.h"

#include <exception>
#include <memory>

#include <iostream>
#include <string>
#include <variant>
#include <vector>

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

    micros3::S3Service s3_service(*store, {cfg.access_key_id, cfg.secret_access_key});
    micros3::UiService ui_service(*store, cfg.ui_port);
    micros3::Server server({&s3_service, &ui_service});
    const bool listening = server.run({cfg.port, cfg.ui_port}, [&cfg](const std::vector<int> &bound) {
        if (bound[0] != 0 && bound[1] != 0) {
            std::cout << "Listening on port " << bound[0] << " (S3) and port " << bound[1]
                      << " (UI) with data directory " << cfg.data_dir << std::endl;
            return;
        }
        if (bound[0] == 0) std::cerr << "Failed to listen on port " << cfg.port << " (S3)" << std::endl;
        if (bound[1] == 0) std::cerr << "Failed to listen on port " << cfg.ui_port << " (UI)" << std::endl;
    });
    return listening ? 0 : 1;
}
