import SwiftUI

/// The board's top row when Appearance picks the burn-rate view: the burn-rate panel with the
/// top sessions beside it. (The other choice is `QuotaRow`.)
struct DashboardRow: View {
    let monitor: Monitor

    private static let gap = 14.0
    static let height = 326.0

    var body: some View {
        let u = monitor.usage
        GeometryReader { geo in
            let avail = geo.size.width - Self.gap
            HStack(spacing: Self.gap) {
                BurnPanel(compact: true)
                    .frame(width: avail * 1.35 / 2)
                TopSessionsCard(rows: u?.top ?? [], weekly: u?.limits?.sevenDay?.utilization, note: monitor.limitsNote,
                                onTap: { monitor.focus($0) }, onRefresh: { monitor.refreshLimits() })
                    .frame(width: avail * 0.65 / 2)
            }
        }
        .frame(height: Self.height)
    }
}
