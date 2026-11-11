import Foundation
import Capacitor
import CoreLocation
import UIKit

@objc(BackgroundLocationPlugin)
public class BackgroundLocationPlugin: CAPPlugin, CLLocationManagerDelegate {
    private var locationManager: CLLocationManager?
    private var lastPosition: CLLocation?
    private var supabaseConfig: SupabaseLocationConfig?
    private var pendingUploadLocation: CLLocation?
    private var uploadInFlight = false
    private var locationUploadEnabled = false
    private var uploadRetryWorkItem: DispatchWorkItem?
    /// While sharing, Core Location may not call `didUpdateLocations` for a long
    /// time when `distanceFilter` suppresses callbacks for a stationary device.
    /// Viewers key off `user_locations.updated_at`, so we periodically re-post the
    /// last good fix with a fresh `updated_at` (same cadence as JS foreground poll).
    private var stationaryUploadHeartbeatTimer: Timer?
    /// iOS 13+ never offers "Always" on the first location alert; the system only
    /// shows the upgrade sheet after `requestAlwaysAuthorization()` is called
    /// while status is already `authorizedWhenInUse`. We set this when we have
    /// invoked that upgrade request during the current sharing session so the
    /// delegate does not stack duplicate prompts; reset in `stop()`.
    private var didRequestAlwaysUpgradeThisSharingSession = false
    private var significantLocationMonitoringActive = false
    private let diagnosticsDefaultsKey = "BackgroundLocationUploadDiagnostics"
    private var lastUploadAt: Date?
    private var lastUploadHttpStatus: Int?
    private var lastUploadErrorSnippet: String?
    private var lastHeartbeatAt: Date?
    private var lastDidUpdateAt: Date?
    private var lastUploadedPosition: CLLocation?
    private var lastSuccessfulUploadAt: Date?
    private var lastDidUpdateLogAt: Date?

    // Queue of pending one-shot getCurrentPosition calls waiting on a fresh fix.
    // Each entry pairs a call with the previous fix timestamp it considers
    // "already seen", so we only resolve it once a genuinely new fix arrives.
    private var pendingFreshCalls: [(call: CAPPluginCall, previousTimestamp: Date?)] = []

    // Maximum age of a cached fix before getCurrentPosition forces a refresh.
    // Anything older risks sending stale coordinates to the server (e.g. when
    // the device has been stationary and Core Location's distanceFilter has
    // suppressed new updates).
    private let cachedLocationMaxAge: TimeInterval = 30

    // Hard deadline for a pending getCurrentPosition call waiting on a fresh
    // fix. If Core Location hasn't delivered anything new by then we give up
    // and let JS treat this poll as "no fix" rather than writing stale
    // coordinates to the DB.
    private let freshFixDeadline: TimeInterval = 12

    // Maximum age, in seconds, of a `CLLocation.timestamp` we'll accept from
    // Core Location. iOS often replays a cached fix (sometimes hours or days
    // old, e.g. after the device travels with the app force-quit) when
    // `startUpdatingLocation` first runs or when the app foregrounds. Those
    // cached fixes were getting forwarded to JS as if they were "live", which
    // is how a phone in Denver kept reporting San Francisco coordinates with
    // a fresh `updated_at`.
    private let acceptedFixMaxAge: TimeInterval = 60

    // Reject fixes whose horizontal accuracy is non-positive (Core Location
    // uses negative values to signal an invalid fix). We don't apply a strict
    // upper bound because that disqualifies indoor users entirely; the age
    // check above is the main defense against stale-cache replay.
    private let minAcceptableHorizontalAccuracy: CLLocationAccuracy = 0
    private let locationUploadRetryDelay: TimeInterval = 15
    /// Keep `js/constants.js` `APP_TIMING.FOREGROUND_LOCATION_POLL_MS` in sync.
    private let stationaryLocationHeartbeatInterval: TimeInterval = 60
    /// Minimum time between movement-driven uploads (heartbeat bypasses this).
    private let minimumUploadInterval: TimeInterval = 60
    /// Upload before `minimumUploadInterval` only if the device moved at least this far.
    private let movementUploadThresholdMeters: CLLocationDistance = 10

    private struct SupabaseLocationConfig: Codable {
        let anonKey: String
        let uploadUrl: String
        let uploadGrant: String
        let uploadGrantExpiresAt: String?
        let userId: String
        let instanceId: String?
        let sourcePlatform: String?
        let sourceUserAgent: String?
    }

    private let configDefaultsKey = "BackgroundLocationSupabaseConfig"
    /// Default distance filter when not actively sharing live location.
    private let idleDistanceFilterMeters: CLLocationDistance = 10
    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    // MARK: - Plugin methods

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.ensureLocationManager()
            guard self.updateSupabaseConfig(from: call) else {
                self.locationUploadEnabled = false
                call.reject("Missing Supabase location upload config")
                return
            }
            self.locationUploadEnabled = true

            let status = self.locationManager?.authorizationStatus ?? .notDetermined
            NSLog("[BackgroundLocation] start() called, authorizationStatus=\(self.describe(status))")

            switch status {
            case .notDetermined:
                // First prompt is always When-In-Use only; the delegate chains
                // `requestAlwaysAuthorization()` after the user grants so they see
                // Apple's second "Change to Always Allow" sheet.
                self.locationManager?.requestWhenInUseAuthorization()
            case .authorizedWhenInUse:
                self.didRequestAlwaysUpgradeThisSharingSession = true
                self.locationManager?.requestAlwaysAuthorization()
            case .denied, .restricted:
                NSLog("[BackgroundLocation] start(): Location services are denied/restricted. User must enable in Settings -> Privacy -> Location Services -> Union.")
            default:
                break
            }

            self.applyBackgroundUpdatesIfAuthorized()
            self.applySharingLocationConfiguration()
            self.locationManager?.startUpdatingLocation()
            NSLog("[BackgroundLocation] startUpdatingLocation called")
            self.scheduleStationaryLocationHeartbeat()
            self.logLocationRuntimeState(context: "start")
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.locationUploadEnabled = false
            self.didRequestAlwaysUpgradeThisSharingSession = false
            self.pendingUploadLocation = nil
            self.uploadRetryWorkItem?.cancel()
            self.uploadRetryWorkItem = nil
            self.invalidateStationaryLocationHeartbeat()
            self.restoreIdleLocationConfiguration()
            self.locationManager?.stopUpdatingLocation()
            self.logLocationRuntimeState(context: "stop")
            call.resolve()
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Plugin not ready")
                return
            }
            self.ensureLocationManager()
            self.applyBackgroundUpdatesIfAuthorized()
            call.resolve(self.buildStatusPayload())
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        // Fresh enough? Return immediately. We require both a recent timestamp
        // and a valid horizontal accuracy — Core Location returns negative
        // accuracy for invalid/cached fixes, which we never want to write.
        if let loc = lastPosition,
           Date().timeIntervalSince(loc.timestamp) < cachedLocationMaxAge,
           loc.horizontalAccuracy > minAcceptableHorizontalAccuracy {
            call.resolve([
                "lat": loc.coordinate.latitude,
                "lng": loc.coordinate.longitude
            ])
            return
        }

        // Otherwise, kick location services to deliver a new fix and queue the
        // call to resolve as soon as a newer `didUpdateLocations` arrives.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Plugin not ready")
                return
            }
            self.ensureLocationManager()

            let previousTimestamp = self.lastPosition?.timestamp
            self.pendingFreshCalls.append((call, previousTimestamp))

            // Request authorization on first use. One-shot callers like the
            // selfie capture reach this code path before `start()` has ever
            // run, so the manager is still in `.notDetermined` and any call
            // to `requestLocation()` would fail immediately with
            // kCLErrorDenied. Ask for When-In-Use here — the broader Always
            // auth is requested later by `start()` when the user actually
            // turns on background location sharing.
            let status = self.locationManager?.authorizationStatus ?? .notDetermined
            let shouldWaitForAuth: Bool
            switch status {
            case .notDetermined:
                self.locationManager?.requestWhenInUseAuthorization()
                shouldWaitForAuth = true
            case .denied, .restricted:
                shouldWaitForAuth = true
            default:
                shouldWaitForAuth = false
            }

            // Only ping Core Location for an immediate fix if we're already
            // authorized; otherwise `locationManagerDidChangeAuthorization`
            // will start updating once the user responds to the prompt, and
            // the resulting `didUpdateLocations` will flush our pending call.
            if !shouldWaitForAuth {
                self.applyBackgroundUpdatesIfAuthorized()
                self.locationManager?.startUpdatingLocation()
                self.locationManager?.requestLocation()
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + self.freshFixDeadline) { [weak self] in
                guard let self = self else { return }
                // Time is up. flushPendingCalls(force: true) will reject any
                // pending callers if we still don't have a sufficiently
                // fresh fix — JS treats that as "no fix this poll" and
                // skips the upsert, which is the desired behavior here.
                self.flushPendingCalls(force: true)
            }
        }
    }

    // MARK: - Delegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Use the most recent acceptable fix. Core Location occasionally
        // hands back cached locations that are seconds — or, after travel
        // with the app force-quit, hours/days — old. We need to drop those
        // before they get forwarded to JS, otherwise they end up in the DB
        // stamped with a fresh `updated_at`.
        guard let location = mostRecent(of: locations) else { return }
        let age = Date().timeIntervalSince(location.timestamp)

        if location.horizontalAccuracy <= minAcceptableHorizontalAccuracy {
            NSLog("[BackgroundLocation] discarding fix with invalid accuracy=\(location.horizontalAccuracy) age=\(String(format: "%.1f", age))s")
            return
        }
        if shouldDiscardSimulatedLocation(location) {
            NSLog("[BackgroundLocation] discarding simulated location lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude)")
            return
        }
        if age > acceptedFixMaxAge {
            NSLog("[BackgroundLocation] discarding stale cached fix age=\(String(format: "%.1f", age))s lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude)")
            // Kick the manager so we get a real fix soon. requestLocation()
            // is idempotent and forces Core Location to deliver a single
            // fresh sample, which will overwrite the cached one.
            manager.requestLocation()
            return
        }

        lastDidUpdateAt = Date()
        persistUploadDiagnostics()
        lastPosition = location

        if shouldUploadLocation(location, bypassThrottle: false) {
            NSLog("[BackgroundLocation] didUpdateLocations lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude) horizAcc=\(location.horizontalAccuracy)m age=\(String(format: "%.1f", age))s — uploading")
            logLocationRuntimeState(context: "didUpdateLocations")
            postLocationToSupabase(location, bypassThrottle: false)
            notifyListeners("locationUpdate", data: [
                "lat": location.coordinate.latitude,
                "lng": location.coordinate.longitude
            ])
        } else if shouldLogThrottledDidUpdate() {
            NSLog("[BackgroundLocation] didUpdateLocations (upload throttled, heartbeat will refresh updated_at)")
        }
        flushPendingCalls(force: false)
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[BackgroundLocation] didFailWithError: \(error.localizedDescription)")
    }

    public func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        NSLog("[BackgroundLocation] location updates paused by system — requesting fix and heartbeat upload")
        manager.requestLocation()
        uploadStationaryHeartbeatIfPossible()
    }

    public func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        NSLog("[BackgroundLocation] location updates resumed")
        uploadStationaryHeartbeatIfPossible()
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        NSLog("[BackgroundLocation] authorization changed -> \(describe(status))")
        if status == .authorizedWhenInUse, locationUploadEnabled,
           !didRequestAlwaysUpgradeThisSharingSession {
            didRequestAlwaysUpgradeThisSharingSession = true
            manager.requestAlwaysAuthorization()
        }
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            applyBackgroundUpdatesIfAuthorized()
            if locationUploadEnabled {
                applySharingLocationConfiguration()
            }
            manager.startUpdatingLocation()
            // If a one-shot caller (e.g. selfie capture) is waiting on this
            // prompt, kick the manager to deliver a single fresh fix asap
            // rather than relying on the continuous-updates stream warming
            // up GPS within their deadline.
            if !pendingFreshCalls.isEmpty {
                manager.requestLocation()
            }
        } else if status == .denied || status == .restricted {
            // Permission was refused. No fix will ever arrive, so resolve
            // any pending one-shot callers now with an empty payload rather
            // than making them wait for the full deadline.
            flushPendingCalls(force: true)
        }
        logLocationRuntimeState(context: "authorizationChanged")
    }

    // MARK: - Helpers

    private func ensureLocationManager() {
        if locationManager == nil {
            let manager = CLLocationManager()
            manager.delegate = self
            // Sharing your live location with a contact is a foreground-ish
            // use case. Nearest-ten-meters gives reasonable accuracy without
            // draining battery the way kCLAccuracyBest would, and a small
            // distanceFilter means Core Location pushes us updates shortly
            // after any real movement instead of waiting for a 100m hop.
            manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            manager.distanceFilter = idleDistanceFilterMeters
            manager.pausesLocationUpdatesAutomatically = false
            loadUploadDiagnostics()
            locationManager = manager
            loadSupabaseConfig()
        }
    }

    private func updateSupabaseConfig(from call: CAPPluginCall) -> Bool {
        guard
            let anonKey = call.getString("anonKey"), !anonKey.isEmpty,
            let uploadUrl = call.getString("uploadUrl"), !uploadUrl.isEmpty,
            let uploadGrant = call.getString("uploadGrant"), !uploadGrant.isEmpty,
            let userId = call.getString("userId"), !userId.isEmpty
        else {
            loadSupabaseConfig()
            return false
        }

        let config = SupabaseLocationConfig(
            anonKey: anonKey,
            uploadUrl: uploadUrl,
            uploadGrant: uploadGrant,
            uploadGrantExpiresAt: call.getString("uploadGrantExpiresAt"),
            userId: userId,
            instanceId: call.getString("instanceId"),
            sourcePlatform: call.getString("sourcePlatform"),
            sourceUserAgent: call.getString("sourceUserAgent")
        )
        supabaseConfig = config
        if let encoded = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(encoded, forKey: configDefaultsKey)
        }
        NSLog("[BackgroundLocation] updated Supabase config user=\(redact(config.userId)) instance=\(redact(config.instanceId))")
        startNextLocationUploadIfNeeded()
        return true
    }

    private func loadSupabaseConfig() {
        if supabaseConfig != nil { return }
        guard let data = UserDefaults.standard.data(forKey: configDefaultsKey),
              let config = try? JSONDecoder().decode(SupabaseLocationConfig.self, from: data)
        else { return }
        supabaseConfig = config
    }

    private func scheduleStationaryLocationHeartbeat() {
        invalidateStationaryLocationHeartbeat()
        uploadStationaryHeartbeatIfPossible()
        let timer = Timer(timeInterval: stationaryLocationHeartbeatInterval, repeats: true) { [weak self] _ in
            self?.uploadStationaryHeartbeatIfPossible()
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        stationaryUploadHeartbeatTimer = timer
    }

    private func invalidateStationaryLocationHeartbeat() {
        stationaryUploadHeartbeatTimer?.invalidate()
        stationaryUploadHeartbeatTimer = nil
    }

    /// Re-upsert the latest coordinates so `updated_at` stays fresh for viewers
    /// when the device has not moved enough to trigger `didUpdateLocations`.
    private func uploadStationaryHeartbeatIfPossible() {
        guard locationUploadEnabled else { return }
        guard let location = lastPosition else { return }
        guard location.horizontalAccuracy > minAcceptableHorizontalAccuracy else { return }
        lastHeartbeatAt = Date()
        persistUploadDiagnostics()
        NSLog("[BackgroundLocation] stationary heartbeat upload lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude) fixAge=\(String(format: "%.1f", Date().timeIntervalSince(location.timestamp)))s")
        locationManager?.requestLocation()
        postLocationToSupabase(location, bypassThrottle: true)
    }

    private func postLocationToSupabase(_ location: CLLocation, bypassThrottle: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.locationUploadEnabled else {
                NSLog("[BackgroundLocation] location upload skipped: upload disabled")
                return
            }
            guard self.shouldUploadLocation(location, bypassThrottle: bypassThrottle) else {
                return
            }
            self.pendingUploadLocation = location
            self.uploadRetryWorkItem?.cancel()
            self.uploadRetryWorkItem = nil
            self.startNextLocationUploadIfNeeded()
        }
    }

    private func startNextLocationUploadIfNeeded() {
        guard !uploadInFlight else { return }
        guard locationUploadEnabled else { return }
        guard let location = pendingUploadLocation else { return }
        guard let config = supabaseConfig else {
            NSLog("[BackgroundLocation] no Supabase config; keeping latest location pending")
            return
        }
        pendingUploadLocation = nil
        uploadInFlight = true

        guard let url = URL(string: config.uploadUrl) else {
            NSLog("[BackgroundLocation] invalid location upload URL")
            uploadInFlight = false
            pendingUploadLocation = location
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(config.anonKey)", forHTTPHeaderField: "Authorization")
        request.setValue(config.uploadGrant, forHTTPHeaderField: "X-Location-Upload-Grant")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "action": "upload",
            "lat": location.coordinate.latitude,
            "lng": location.coordinate.longitude,
            "updated_at": isoFormatter.string(from: Date())
        ]
        NSLog("[BackgroundLocation] uploading location user=\(redact(config.userId)) instance=\(redact(config.instanceId))")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        } catch {
            NSLog("[BackgroundLocation] failed to encode location body: \(error.localizedDescription)")
            uploadInFlight = false
            pendingUploadLocation = location
            return
        }

        var backgroundTask: UIBackgroundTaskIdentifier = .invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "UploadLocation") {
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }

        let session = makeLocationUploadSession()
        session.dataTask(with: request) { [weak self] data, response, error in
            defer {
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                }
            }
            if let error = error {
                NSLog("[BackgroundLocation] Supabase location upload failed: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self?.recordUploadResult(httpStatus: nil, errorSnippet: error.localizedDescription)
                    self?.handleLocationUploadFinished(location: location, succeeded: false)
                }
                return
            }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if statusCode < 200 || statusCode >= 300 {
                let responseBody = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let trimmedBody = String(responseBody.prefix(1000))
                NSLog("[BackgroundLocation] Supabase location upload returned HTTP \(statusCode) body=\(trimmedBody)")
                DispatchQueue.main.async {
                    self?.recordUploadResult(httpStatus: statusCode, errorSnippet: trimmedBody)
                    if statusCode == 401 || statusCode == 403 {
                        self?.handleLocationUploadRejected(location: location)
                    } else {
                        self?.handleLocationUploadFinished(location: location, succeeded: false)
                    }
                }
                return
            }
            NSLog("[BackgroundLocation] Supabase location upload succeeded")
            DispatchQueue.main.async {
                self?.recordUploadResult(httpStatus: statusCode, errorSnippet: nil)
                self?.handleLocationUploadFinished(location: location, succeeded: true)
            }
        }.resume()
    }

    private func makeLocationUploadSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }

    private func handleLocationUploadFinished(location: CLLocation, succeeded: Bool) {
        uploadInFlight = false
        if !succeeded {
            if pendingUploadLocation == nil ||
                (pendingUploadLocation?.timestamp ?? .distantPast) <= location.timestamp {
                pendingUploadLocation = location
            }
            scheduleLocationUploadRetry()
            return
        }
        lastUploadedPosition = location
        lastSuccessfulUploadAt = Date()
        startNextLocationUploadIfNeeded()
    }

    private func handleLocationUploadRejected(location: CLLocation) {
        uploadInFlight = false
        pendingUploadLocation = location
        locationUploadEnabled = false
        invalidateStationaryLocationHeartbeat()
        restoreIdleLocationConfiguration()
        NSLog("[BackgroundLocation] upload grant rejected; waiting for WebView to provide a fresh grant")
    }

    /// Movement-driven uploads are capped at ~60s unless the user moves ≥10 m.
    /// Stationary heartbeats pass `bypassThrottle: true`.
    private func shouldUploadLocation(_ location: CLLocation, bypassThrottle: Bool) -> Bool {
        if bypassThrottle { return true }
        guard let lastAt = lastSuccessfulUploadAt else { return true }
        let elapsed = Date().timeIntervalSince(lastAt)
        if elapsed >= minimumUploadInterval { return true }
        if let lastUploaded = lastUploadedPosition,
           location.distance(from: lastUploaded) >= movementUploadThresholdMeters {
            return true
        }
        return false
    }

    private func shouldLogThrottledDidUpdate() -> Bool {
        let now = Date()
        if let last = lastDidUpdateLogAt, now.timeIntervalSince(last) < 30 { return false }
        lastDidUpdateLogAt = now
        return true
    }

    private func scheduleLocationUploadRetry() {
        guard uploadRetryWorkItem == nil else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.uploadRetryWorkItem = nil
            self.startNextLocationUploadIfNeeded()
        }
        uploadRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + locationUploadRetryDelay, execute: workItem)
    }

    /// While live sharing is active, use settings that reduce iOS 16.4+
    /// background suspension (blue bar + significant-change wake). Keep a
    /// 10 m distance filter so GPS jitter does not upload every second.
    private func applySharingLocationConfiguration() {
        guard let manager = locationManager, locationUploadEnabled else { return }
        manager.distanceFilter = idleDistanceFilterMeters
        if manager.authorizationStatus == .authorizedAlways {
            manager.showsBackgroundLocationIndicator = false
        }
        if CLLocationManager.significantLocationChangeMonitoringAvailable(),
           !significantLocationMonitoringActive {
            manager.startMonitoringSignificantLocationChanges()
            significantLocationMonitoringActive = true
            NSLog("[BackgroundLocation] started significant location change monitoring")
        }
    }

    private func restoreIdleLocationConfiguration() {
        guard let manager = locationManager else { return }
        manager.distanceFilter = idleDistanceFilterMeters
        manager.showsBackgroundLocationIndicator = false
        if significantLocationMonitoringActive {
            manager.stopMonitoringSignificantLocationChanges()
            significantLocationMonitoringActive = false
            NSLog("[BackgroundLocation] stopped significant location change monitoring")
        }
    }

    private func recordUploadResult(httpStatus: Int?, errorSnippet: String?) {
        lastUploadAt = Date()
        lastUploadHttpStatus = httpStatus
        lastUploadErrorSnippet = errorSnippet.map { String($0.prefix(200)) }
        persistUploadDiagnostics()
    }

    private struct PersistedUploadDiagnostics: Codable {
        let lastUploadAt: Date?
        let lastUploadHttpStatus: Int?
        let lastUploadErrorSnippet: String?
        let lastHeartbeatAt: Date?
        let lastDidUpdateAt: Date?
    }

    private func persistUploadDiagnostics() {
        let snapshot = PersistedUploadDiagnostics(
            lastUploadAt: lastUploadAt,
            lastUploadHttpStatus: lastUploadHttpStatus,
            lastUploadErrorSnippet: lastUploadErrorSnippet,
            lastHeartbeatAt: lastHeartbeatAt,
            lastDidUpdateAt: lastDidUpdateAt
        )
        if let encoded = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(encoded, forKey: diagnosticsDefaultsKey)
        }
    }

    private func loadUploadDiagnostics() {
        guard let data = UserDefaults.standard.data(forKey: diagnosticsDefaultsKey),
              let snapshot = try? JSONDecoder().decode(PersistedUploadDiagnostics.self, from: data)
        else { return }
        lastUploadAt = snapshot.lastUploadAt
        lastUploadHttpStatus = snapshot.lastUploadHttpStatus
        lastUploadErrorSnippet = snapshot.lastUploadErrorSnippet
        lastHeartbeatAt = snapshot.lastHeartbeatAt
        lastDidUpdateAt = snapshot.lastDidUpdateAt
    }

    private func isoString(_ date: Date?) -> String? {
        guard let date = date else { return nil }
        return isoFormatter.string(from: date)
    }

    /// `allowsBackgroundLocationUpdates` requires Always authorization at the
    /// time it's set. Setting it earlier is ignored (or on some iOS versions,
    /// logs a runtime warning), so we defer it until we actually have the
    /// right permission.
    private func applyBackgroundUpdatesIfAuthorized() {
        guard let manager = locationManager else { return }
        let status = manager.authorizationStatus
        if status == .authorizedAlways {
            if !manager.allowsBackgroundLocationUpdates {
                manager.allowsBackgroundLocationUpdates = true
            }
            // No blue "Union is using your location" bar while sharing. With
            // Always authorization iOS still shows the small arrow in the
            // status bar, which is the same signal Find My and Google Maps give.
            manager.showsBackgroundLocationIndicator = false
        } else {
            if manager.allowsBackgroundLocationUpdates {
                manager.allowsBackgroundLocationUpdates = false
            }
        }
    }

    private func buildStatusPayload() -> [String: Any] {
        var base: [String: Any] = [
            "hasSupabaseConfig": supabaseConfig != nil,
            "hasUploadGrant": !(supabaseConfig?.uploadGrant.isEmpty ?? true),
            "configUser": redact(supabaseConfig?.userId),
            "configInstance": redact(supabaseConfig?.instanceId),
            "locationUploadEnabled": locationUploadEnabled,
            "hasPendingUpload": pendingUploadLocation != nil,
            "uploadInFlight": uploadInFlight,
            "appState": describe(UIApplication.shared.applicationState),
            "significantLocationMonitoringActive": significantLocationMonitoringActive
        ]
        if let v = isoString(lastUploadAt) { base["lastUploadAt"] = v }
        if let v = lastUploadHttpStatus { base["lastUploadHttpStatus"] = v }
        if let v = lastUploadErrorSnippet { base["lastUploadErrorSnippet"] = v }
        if let v = isoString(lastHeartbeatAt) { base["lastHeartbeatAt"] = v }
        if let v = isoString(lastDidUpdateAt) { base["lastDidUpdateAt"] = v }
        if let v = supabaseConfig?.uploadGrantExpiresAt { base["uploadGrantExpiresAt"] = v }
        guard let manager = locationManager else {
            base["authorizationStatus"] = "notInitialized"
            base["allowsBackgroundLocationUpdates"] = false
            base["pausesLocationUpdatesAutomatically"] = false
            base["showsBackgroundLocationIndicator"] = false
            base["distanceFilter"] = idleDistanceFilterMeters
            return base
        }
        base["authorizationStatus"] = describe(manager.authorizationStatus)
        base["allowsBackgroundLocationUpdates"] = manager.allowsBackgroundLocationUpdates
        base["pausesLocationUpdatesAutomatically"] = manager.pausesLocationUpdatesAutomatically
        base["showsBackgroundLocationIndicator"] = manager.showsBackgroundLocationIndicator
        base["distanceFilter"] = manager.distanceFilter
        return base
    }

    private func logLocationRuntimeState(context: String) {
        let status = buildStatusPayload()
        NSLog("[BackgroundLocation] state[\(context)] authorizationStatus=\(status["authorizationStatus"] ?? "") allowsBackgroundLocationUpdates=\(status["allowsBackgroundLocationUpdates"] ?? false) pausesLocationUpdatesAutomatically=\(status["pausesLocationUpdatesAutomatically"] ?? false) hasSupabaseConfig=\(status["hasSupabaseConfig"] ?? false) configUser=\(status["configUser"] ?? "") configInstance=\(status["configInstance"] ?? "") locationUploadEnabled=\(status["locationUploadEnabled"] ?? false) hasPendingUpload=\(status["hasPendingUpload"] ?? false) uploadInFlight=\(status["uploadInFlight"] ?? false) appState=\(status["appState"] ?? "")")
    }

    private func mostRecent(of locations: [CLLocation]) -> CLLocation? {
        return locations.max(by: { $0.timestamp < $1.timestamp })
    }

    private func shouldDiscardSimulatedLocation(_ location: CLLocation) -> Bool {
        if #available(iOS 15.0, *) {
            guard location.sourceInformation?.isSimulatedBySoftware == true else { return false }
            #if DEBUG
            NSLog("[BackgroundLocation] accepting simulated location in DEBUG build for testing")
            return false
            #else
            return true
            #endif
        }
        return false
    }

    private func describe(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }

    private func describe(_ state: UIApplication.State) -> String {
        switch state {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown(\(state.rawValue))"
        }
    }

    private func redact(_ value: String?) -> String {
        guard let value = value, !value.isEmpty else { return "nil" }
        if value.count <= 12 { return value }
        return "\(value.prefix(6))...\(value.suffix(6))"
    }

    /// Resolve any pending getCurrentPosition calls. When `force` is false,
    /// we only resolve calls whose `previousTimestamp` differs from the
    /// current `lastPosition.timestamp` (i.e. a new fix has genuinely
    /// arrived). When `force` is true the caller's deadline is up; in that
    /// case we still only resolve with `lastPosition` if it's *both* newer
    /// than what the caller had AND fresh enough to be worth writing. If not,
    /// resolve with an empty object so JS treats the poll as "no fix" without
    /// Capacitor logging noisy promise rejections.
    private func flushPendingCalls(force: Bool) {
        guard !pendingFreshCalls.isEmpty else { return }
        let current = lastPosition
        var remaining: [(call: CAPPluginCall, previousTimestamp: Date?)] = []

        for entry in pendingFreshCalls {
            let isNew = current.map { $0.timestamp != entry.previousTimestamp } ?? false
            let isFreshEnough = current.map {
                Date().timeIntervalSince($0.timestamp) <= acceptedFixMaxAge &&
                    $0.horizontalAccuracy > minAcceptableHorizontalAccuracy
            } ?? false

            if let loc = current, isNew, isFreshEnough {
                entry.call.resolve([
                    "lat": loc.coordinate.latitude,
                    "lng": loc.coordinate.longitude
                ])
            } else if force {
                NSLog("[BackgroundLocation] getCurrentPosition timed out without a fresh fix (had cached fix: \(current != nil))")
                entry.call.resolve([:])
            } else {
                remaining.append(entry)
            }
        }
        pendingFreshCalls = remaining
    }
}
    