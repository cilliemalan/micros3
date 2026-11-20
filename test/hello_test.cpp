#include "micros3/hello.h"

#include <gtest/gtest.h>

TEST(Hello, ReturnsGreeting) {
    EXPECT_EQ(micros3::hello(), "Hello, world!");
}
