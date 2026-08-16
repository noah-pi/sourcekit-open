// This file is licensed to you under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0) or the MIT license
// (http://opensource.org/licenses/MIT), at your option.
//
// Unless required by applicable law or agreed to in writing, this software is
// distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS OF
// ANY KIND, either express or implied. See the LICENSE-MIT and LICENSE-APACHE
// files for the specific language governing permissions and limitations under
// each license.
//
//  C2PASettings.swift
//

@_implementationOnly import C2PAC
import Foundation

/// Manages C2PA settings configuration.
///
/// `C2PASettings` provides a Swift-idiomatic interface for loading and applying
/// C2PA settings in JSON or TOML format. Settings control signer configuration,
/// CAWG identity assertions, thumbnail generation, and other build options.
///
/// Settings can be loaded from raw JSON/TOML strings or from a type-safe
/// ``C2PASettingsDefinition`` struct.
///
/// ## Example
///
/// ```swift
/// // From a raw JSON string
/// let settings = try C2PASettings(json: settingsJSON)
///
/// // From a type-safe definition
/// let definition = C2PASettingsDefinition(
///     version: 1,
///     signer: .local(LocalSignerSettings(
///         alg: "es256",
///         signCert: certPEM,
///         privateKey: keyPEM
///     ))
/// )
/// let settings = try C2PASettings(definition: definition)
/// ```
///
/// - SeeAlso: ``Signer``, ``C2PASettingsDefinition``
public final class C2PASettings {
    private var settingsString: String
    private var format: String

    /// Creates settings from a JSON string.
    ///
    /// - Parameter json: A JSON string containing C2PA settings.
    /// - Throws: ``C2PAError`` if the JSON is invalid.
    public init(json: String) throws {
        self.settingsString = json
        self.format = "json"
        try apply()
    }

    /// Creates settings from a TOML string.
    ///
    /// - Parameter toml: A TOML string containing C2PA settings.
    /// - Throws: ``C2PAError`` if the TOML is invalid.
    public init(toml: String) throws {
        self.settingsString = toml
        self.format = "toml"
        try apply()
    }

    /// Creates settings from a type-safe ``C2PASettingsDefinition``.
    ///
    /// The definition is encoded to JSON and applied to the C2PA runtime.
    ///
    /// - Parameter definition: A settings definition struct.
    /// - Throws: ``C2PAError`` if the settings are invalid.
    ///
    /// - SeeAlso: ``C2PASettingsDefinition``
    public init(definition: C2PASettingsDefinition) throws {
        self.settingsString = try C2PAJson.encode(definition)
        self.format = "json"
        try apply()
    }

    /// Loads additional JSON settings, merging with existing configuration.
    ///
    /// - Parameter json: A JSON string containing C2PA settings to merge.
    /// - Throws: ``C2PAError`` if the JSON is invalid.
    public func load(json: String) throws {
        self.settingsString = json
        self.format = "json"
        try apply()
    }

    /// Loads additional TOML settings, merging with existing configuration.
    ///
    /// - Parameter toml: A TOML string containing C2PA settings to merge.
    /// - Throws: ``C2PAError`` if the TOML is invalid.
    public func load(toml: String) throws {
        self.settingsString = toml
        self.format = "toml"
        try apply()
    }

    /// Loads settings from a type-safe ``C2PASettingsDefinition``,
    /// merging with existing configuration.
    ///
    /// - Parameter definition: A settings definition struct.
    /// - Throws: ``C2PAError`` if the settings are invalid.
    public func load(definition: C2PASettingsDefinition) throws {
        self.settingsString = try C2PAJson.encode(definition)
        self.format = "json"
        try apply()
    }

    /// Sets a single value at the given dot-separated path within the settings.
    ///
    /// This method parses the current JSON settings, navigates to the specified
    /// path, sets the value, and re-applies the updated settings.
    ///
    /// - Parameters:
    ///   - value: The value to set. Must be a JSON-compatible type
    ///     (`String`, `Int`, `Double`, `Bool`, or `nil`).
    ///   - path: A dot-separated path (e.g., `"builder.thumbnail.format"`).
    ///
    /// - Throws: ``C2PAError`` if the format is not JSON or the path is invalid.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let settings = try C2PASettings(json: "{\"version\": 1}")
    /// try settings.setValue("es256", forPath: "signer.local.alg")
    /// ```
    public func setValue(_ value: Any, forPath path: String) throws {
        guard format == "json" else {
            throw C2PAError.api("setValue is only supported for JSON settings")
        }

        guard let data = settingsString.data(using: .utf8),
              var json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw C2PAError.api("Current settings are not a valid JSON object")
        }

        let components = path.split(separator: ".").map(String.init)
        guard !components.isEmpty else {
            throw C2PAError.api("Path must not be empty")
        }

        setNestedValue(&json, components: components, value: value)

        let updatedData = try JSONSerialization.data(withJSONObject: json)
        guard let updatedString = String(data: updatedData, encoding: .utf8) else {
            throw C2PAError.utf8
        }

        self.settingsString = updatedString
        try apply()
    }

    /// Creates a ``Signer`` from the loaded settings.
    ///
    /// - Returns: A configured ``Signer`` instance.
    /// - Throws: ``C2PAError`` if a signer cannot be created from the settings.
    public func createSigner() throws -> Signer {
        if format == "json" {
            return try Signer(settingsJSON: settingsString)
        } else {
            return try Signer(settingsTOML: settingsString)
        }
    }

    // MARK: - Private

    private func apply() throws {
        try settingsString.withCString { settingsPtr in
            try format.withCString { formatPtr in
                let result = c2pa_load_settings(settingsPtr, formatPtr)
                guard result == 0 else {
                    throw C2PAError.api(lastC2PAError())
                }
            }
        }
    }

    private func setNestedValue(
        _ dict: inout [String: Any],
        components: [String],
        value: Any
    ) {
        guard let key = components.first else { return }

        if components.count == 1 {
            dict[key] = value
        } else {
            var nested = dict[key] as? [String: Any] ?? [:]
            setNestedValue(&nested, components: Array(components.dropFirst()), value: value)
            dict[key] = nested
        }
    }
}
