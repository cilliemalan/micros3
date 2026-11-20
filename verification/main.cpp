#include "verify.h"

#include <iostream>

int main(int argc, char *argv[]) {
    return verification::run(argc, argv, std::cout, std::cerr);
}
