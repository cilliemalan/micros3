#pragma once

// The S3 service: routes each request (router.h) to its operation handler.

#include "micros3/http.h"
#include "micros3/router.h"

namespace micros3 {

class S3Service : public http::Service {
public:
    std::unique_ptr<http::Exchange> begin(const http::Request &request) override;
};

} // namespace micros3
