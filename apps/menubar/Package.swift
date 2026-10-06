// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "FactoryMenu",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "FactoryMenu", targets: ["FactoryMenu"]),
        .library(name: "FactoryKit", targets: ["FactoryKit"]),
    ],
    targets: [
        // Everything testable: API models/client, notification rules, process supervisor.
        .target(name: "FactoryKit"),
        // The SwiftUI menu bar app.
        .executableTarget(name: "FactoryMenu", dependencies: ["FactoryKit"]),
        .testTarget(name: "FactoryKitTests", dependencies: ["FactoryKit"], resources: [.copy("Fixtures")]),
    ]
)
