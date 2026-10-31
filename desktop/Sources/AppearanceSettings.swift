import SwiftUI

/// Appearance: presets, then each option on its own, with a live preview of the result.
struct AppearanceSettingsView: View {
    @ObservedObject var appearance = Appearance.shared
    let monitor = Monitor.shared

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section(String(localized: "Presets"), String(localized: "Sets theme, menu bar style, island and motion at once; each can still be changed on its own afterwards")) {
                        // Rows of four, so a pack can add presets without pushing the page sideways.
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 4), alignment: .leading, spacing: 12) {
                            ForEach(Preset.all) { p in
                                PresetCard(preset: p, selected: appearance.presetID == p.id) { appearance.apply(p) }
                            }
                        }
                    }
                    section(String(localized: "Theme"), String(localized: "Colors, fonts and finish of the board, the menu bar panel and the island")) {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                            ForEach(Themes.all, id: \.id) { t in
                                ThemeChip(id: t.id, selected: appearance.config.theme == t.id) { appearance.config.theme = t.id }
                            }
                        }
                    }
                    section(String(localized: "Menu bar style"), String(localized: "Sample: 1 waiting for you, 2 running, 1 new")) {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                            ForEach(MenuBarStyle.allCases) { s in
                                StyleTile(style: s, selected: appearance.config.menuBar == s) { appearance.config.menuBar = s }
                            }
                        }
                    }
                    section(String(localized: "Island"), String(localized: "Notch mode grows out of the notch and shows a pill on screens without one; floating mode is always a pill. The pill can be dragged anywhere")) {
                        Picker("", selection: $appearance.config.island) {
                            ForEach(IslandMode.allCases) { Text($0.name).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 18) {
                                Toggle("Expand on hover", isOn: $appearance.config.islandHover)
                                Toggle("Pop up when a task finishes or needs you", isOn: $appearance.config.islandLiveActivity)
                            }
                            Toggle("Hide until a task needs you or finishes", isOn: $appearance.config.islandAutoHide)
                        }
                        .disabled(appearance.config.island == .off)
                        .font(.system(size: 12))
                    }
                    section(String(localized: "Character"), String(localized: "Shown in the menu bar and the island when nothing is running, waiting or new, with color and energy that follow how much usage limit is left. The phone's status screen shows it too; the drawn characters there act out every state")) {
                        // Four to a row, so the names keep room as characters are added.
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: min(Characters.all.count, 4)), spacing: 10) {
                            ForEach(Characters.all, id: \.self) { id in
                                CharacterTile(id: id, selected: appearance.config.character == id) { appearance.config.character = id }
                            }
                        }
                    }
                    section(String(localized: "Motion"), String(localized: "Spinners, pulses, breathing glow and island animations; “Gentle” keeps only a slow spinner")) {
                        Picker("", selection: $appearance.config.motion) {
                            ForEach(Motion.allCases) { Text($0.name).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(maxWidth: 260)
                    }
                    Button("Restore defaults") { appearance.config = AppearanceConfig() }
                        .buttonStyle(.link)
                        .font(.system(size: 12))
                }
                .padding(22)
            }
            .frame(width: 560)

            AppearancePreview(monitor: monitor)
                .frame(width: 330)
                .frame(maxHeight: .infinity)
        }
        .frame(width: 890, height: 640)
        .background(ThemedBackdrop().ignoresSafeArea())
        .themedPage()
        .id(appearance.revision)
    }

    private func section<Content: View>(_ title: String, _ hint: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .bold))
                Text(hint).font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
            content()
        }
    }
}

private struct PresetCard: View {
    let preset: Preset
    let selected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Themes.palette(preset.config.theme)
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(p.backdrop ?? Color(nsColor: .windowBackgroundColor))
                    if p.grid { GridPattern(color: p.doing.opacity(0.15), spacing: 9).clipShape(RoundedRectangle(cornerRadius: 8)) }
                    if p.scanlines { Scanlines().clipShape(RoundedRectangle(cornerRadius: 8)) }
                    VStack(spacing: 6) {
                        Image(nsImage: MenuBarRenderer.render(.sample, style: preset.config.menuBar, spin: 0.3, palette: p,
                                                              ink: p.backdrop != nil || scheme == .dark ? .white : .black))
                        HStack(spacing: 5) {
                            ForEach([p.waiting, p.doing, p.success], id: \.self) { c in
                                RoundedRectangle(cornerRadius: min(p.corner, 4)).fill(c)
                                    .frame(width: 14, height: 5)
                                    .shadow(color: p.glow > 0 ? c.opacity(0.9) : .clear, radius: p.glow * 0.4)
                            }
                        }
                    }
                }
                .frame(height: 70)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 2 : 1))
                Text(preset.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(preset.blurb).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A theme to pick: its name in its own font and colors on its backdrop, with its four state colors.
private struct ThemeChip: View {
    let id: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let p = Themes.palette(id)
        Button(action: action) {
            HStack(spacing: 6) {
                HStack(spacing: 3) {
                    ForEach([p.waiting, p.doing, p.success, p.failed], id: \.self) { Circle().fill($0).frame(width: 7, height: 7) }
                }
                Text(Themes.name(id))
                    .font(.system(size: 11.5, weight: .medium))
                    .fontDesign(p.fontDesign)
                    .foregroundStyle(p.text ?? Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7).fill(p.backdrop ?? Color(nsColor: .windowBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct StyleTile: View {
    let style: MenuBarStyle
    let selected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    // A strip of fake menu bar so the badge is judged where it lives.
                    RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.08))
                    Image(nsImage: MenuBarRenderer.render(.sample, style: style, spin: 0.3, ink: scheme == .dark ? .white : .black))
                }
                .frame(height: 34)
                Text(style.name).font(.system(size: 11.5, weight: selected ? .bold : .regular))
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.accentColor.opacity(0.14) : .clear))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.1), lineWidth: selected ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct CharacterTile: View {
    let id: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.85))
                    if id == Characters.classic {
                        Image(systemName: "checkmark.circle").font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                    } else {
                        LiveCharacter(character: id, height: 26)
                    }
                }
                .frame(height: 40)
                Text(Characters.name(id)).font(.system(size: 11.5, weight: selected ? .bold : .regular)).lineLimit(1)
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.accentColor.opacity(0.14) : .clear))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.1), lineWidth: selected ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Sample cards and the live menu bar badge in the current theme.
private struct AppearancePreview: View {
    let monitor: Monitor
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let now = monitor.now.timeIntervalSince1970 * 1000
        VStack(alignment: .leading, spacing: 12) {
            Text("Preview").font(.system(size: 14, weight: .bold))
            HStack {
                Spacer()
                Image(nsImage: MenuBarRenderer.render(.sample, style: Appearance.shared.config.menuBar,
                                                      spin: monitor.now.timeIntervalSince1970.truncatingRemainder(dividingBy: 1),
                                                      ink: scheme == .dark ? .white : .black))
                Image(systemName: "wifi").font(.system(size: 12)).foregroundStyle(.secondary)
                Text("14:30").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.08)))
            ForEach(samples(now)) { item in
                TaskCard(item: item, monitor: monitor).allowsHitTesting(false)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(Theme.column)
    }

    private func samples(_ now: Double) -> [TaskItem] {
        let m = 60_000.0
        return [
            TaskItem(id: "preview-wait", title: String(localized: "Move the orders table to new partitions"),
                     goal: String(localized: "The migration script is ready and needs your OK before it runs"), state: "waiting", kind: "prompt",
                     label: String(localized: "Needs permission"), detail: "Bash · psql -f migrate.sql", since: now - 4 * m, project: "orders",
                     host: HostInfo(kind: "iterm", app: "iTerm", tty: "/dev/ttys003"), live: true, turnStartedAt: now - 9 * m,
                     history: [Seg(k: "doing", t: now - 9 * m), Seg(k: "waiting", t: now - 4 * m)]),
            TaskItem(id: "preview-doing", title: String(localized: "Refactor the login form validation"),
                     goal: String(localized: "3 components done, running unit tests"), state: "doing",
                     label: String(localized: "Running"), detail: "Bash · npm test", since: now - 6 * m, project: "web",
                     host: HostInfo(kind: "iterm", app: "iTerm", tty: "/dev/ttys005"), live: true, turnStartedAt: now - 6 * m,
                     history: [Seg(k: "done:success", t: now - 25 * m), Seg(k: "doing", t: now - 6 * m)], unread: nil),
        ]
    }
}
