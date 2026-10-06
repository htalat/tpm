import Foundation

public enum APIError: Error, LocalizedError, Sendable {
    case unreachable(String)
    case http(Int, String)

    public var errorDescription: String? {
        switch self {
        case .unreachable(let m): return "factory API unreachable: \(m)"
        case .http(let code, let body): return "HTTP \(code): \(body)"
        }
    }
}

/// Talks only to the factory's REST API. The app never touches PostgreSQL or `gh` directly.
public struct APIClient: Sendable {
    public var baseURL: URL
    public var token: String?
    private let session: URLSession

    public init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8
        self.session = URLSession(configuration: cfg)
    }

    private func request(_ method: String, _ path: String) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if method == "POST" {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = Data("{}".utf8)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.unreachable(error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw APIError.http(code, String(decoding: data, as: UTF8.self))
        }
        return data
    }

    public func ready() async -> Bool {
        (try? await request("GET", "ready")) != nil
    }

    /// The 50 newest runs (the API's default page).
    public func runs() async throws -> RunsResponse {
        try JSONDecoder().decode(RunsResponse.self, from: try await request("GET", "agent-runs"))
    }

    public func detail(_ id: String) async throws -> RunDetail {
        try JSONDecoder().decode(RunDetail.self, from: try await request("GET", "agent-runs/\(id)"))
    }

    public enum Action: String, Sendable { case approve, retry, cancel }

    public func perform(_ action: Action, run id: String) async throws {
        _ = try await request("POST", "agent-runs/\(id)/\(action.rawValue)")
    }
}
