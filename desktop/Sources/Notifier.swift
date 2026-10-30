import Foundation
import UserNotifications

/// System notifications with a "Jump to task" action that focuses the task's window.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    var onFocus: ((String) -> Void)?
    private(set) var authorized = false

    func setup() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let focus = UNNotificationAction(identifier: "FOCUS", title: String(localized: "Jump to task"), options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: "TASK", actions: [focus], intentIdentifiers: [])])
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            self.authorized = granted
        }
    }

    func post(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = "TASK"
        content.threadIdentifier = id
        content.userInfo = ["id": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "\(id)-\(Date().timeIntervalSince1970)", content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["id"] as? String,
           response.actionIdentifier == "FOCUS" || response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            DispatchQueue.main.async { self.onFocus?(id) }
        }
        completionHandler()
    }

    // Show banners even while our own window is frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
