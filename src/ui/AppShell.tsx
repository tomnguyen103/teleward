import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RHYTHM_CLASSES, type PtbxlCaseRecord, type RhythmClass } from '../types/teleward.ts';
import type { BedState } from '../engine/aclsEngine.ts';

export type ActiveRouteArea = 'shift' | 'daily' | 'caliper' | 'cohort';

const SIDEBAR_STORAGE_KEY = 'teleward_sidebar_collapsed_v1';

export interface AppShellProps {
  activeArea: ActiveRouteArea;
  currentPath: string;
  onNavigate: (path: string) => void;
  beds: readonly BedState[];
  selectedBedIndex: number;
  onSelectBed: (index: number) => void;
  records: readonly PtbxlCaseRecord[];
  canAccessCase?: (record: PtbxlCaseRecord) => boolean;
  activeRhythmFilter: RhythmClass | 'ALL';
  onSelectRhythmFilter: (rhythm: RhythmClass | 'ALL') => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  audioArmed: boolean;
  audioMuted: boolean;
  onToggleAudioArmOrMute: () => void;
  darkTheme: boolean;
  onToggleTheme: () => void;
  cohortBannerText?: string | null;
  inspectorContent: ComponentChildren;
  children: ComponentChildren;
}

export function AppShell(props: AppShellProps) {
  const {
    activeArea,
    onNavigate,
    beds,
    selectedBedIndex,
    onSelectBed,
    records,
    canAccessCase,
    activeRhythmFilter,
    onSelectRhythmFilter,
    searchQuery,
    onSearchQueryChange,
    audioArmed,
    audioMuted,
    onToggleAudioArmOrMute,
    darkTheme,
    onToggleTheme,
    cohortBannerText,
    inspectorContent,
    children,
  } = props;

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage?.setItem(SIDEBAR_STORAGE_KEY, String(next));
        } catch {
          // Ignore storage quota errors
        }
      }
      return next;
    });
    setMobileDrawerOpen((m) => !m);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navItems: Array<{ area: ActiveRouteArea; label: string; href: string }> = [
    { area: 'shift', label: '4-Bed ICU Shift', href: '/shift' },
    { area: 'daily', label: 'Daily Code', href: '/daily' },
    { area: 'caliper', label: '12-Lead Calipers', href: '/caliper/ptbxl-001' },
    { area: 'cohort', label: 'Cohort & Exam Pass', href: '/cohort' },
  ];

  const workspaceGridCols = sidebarCollapsed
    ? 'grid-cols-1 md:grid-cols-[56px_minmax(0,1fr)] xl:grid-cols-[56px_minmax(0,1fr)_360px]'
    : 'grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_360px]';

  return (
    <div class="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }}>
      {/* Top Status Strip (36px max) for IEC 60601-1-8 Audio Arming & Cohort Seed */}
      <div
        data-testid="audio-arm-banner"
        class="h-9 px-4 flex items-center justify-between text-sm border-b"
        style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)' }}
      >
        <div class="flex items-center gap-3">
          <span>
            {audioArmed && !audioMuted
              ? 'IEC 60601-1-8 Harmonic Alarm Synthesizer Armed'
              : 'Audio Paused — Click to Arm IEC 60601-1-8 Alarms'}
          </span>
          {cohortBannerText ? (
            <span class="px-2 py-0.5 rounded text-sm" style={{ backgroundColor: 'var(--surface)', color: 'var(--text)' }}>
              {cohortBannerText}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onToggleAudioArmOrMute}
          class="min-h-9 px-3 inline-flex items-center relative before:absolute before:-inset-1 text-sm font-medium underline"
          style={{ color: 'var(--primary)' }}
        >
          {audioArmed && !audioMuted ? 'Mute Audio' : 'Arm Audio'}
        </button>
      </div>

      {/* Single 64px Sticky Top Bar */}
      <header
        class="sticky top-0 z-30 h-16 px-4 border-b grid grid-cols-[1fr_minmax(0,360px)_1fr] items-center gap-4"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            data-testid="sidebar-collapse-toggle"
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-controls="tw-scope-sidebar"
            aria-label={sidebarCollapsed ? 'Expand ICU Scope Sidebar (Ctrl+B)' : 'Collapse ICU Scope Sidebar (Ctrl+B)'}
            title="Toggle Scope Sidebar (Ctrl+B)"
            class="tw-icon-btn shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>

          <a
            href="/shift"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/shift');
            }}
            class="h-10 flex items-center gap-2 font-semibold text-base no-underline shrink-0"
            style={{ color: 'var(--text)' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M2 12h4l3-8 4 16 3-8h6" />
            </svg>
            <span>TeleWard</span>
          </a>

          <nav aria-label="Primary Workspace Navigation" class="hidden md:flex items-center gap-1 h-16">
            {navItems.map((item) => {
              const isActive = activeArea === item.area;
              return (
                <a
                  key={item.area}
                  href={item.href}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(item.href);
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  class="h-16 px-3 inline-flex items-center text-sm font-medium no-underline transition-colors"
                  style={{
                    color: isActive ? 'var(--primary)' : 'var(--text-muted)',
                    borderBottom: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                  }}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </div>

        {/* Center Quick Case & Rhythm Filter */}
        <div class="w-full">
          <label htmlFor="tw-global-search" class="sr-only">
            Filter PTB-XL cases or rhythm class
          </label>
          <div
            class="flex items-center px-3 h-10 rounded-md border"
            style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="mr-2 shrink-0">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              id="tw-global-search"
              name="globalSearch"
              type="search"
              autocomplete="off"
              value={searchQuery}
              onInput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
              placeholder="Filter 120 PTB-XL cases or rhythm (Ctrl+K)"
              class="w-full h-10 bg-transparent border-0 text-sm focus:outline-none"
              style={{ color: 'var(--text)' }}
            />
          </div>
        </div>

        {/* Right Contiguous Action Cluster (40x40 square icon buttons, 8px gap, zero text between icons) */}
        <div class="justify-self-end flex items-center gap-2" role="toolbar" aria-label="Station Controls">
          <button
            type="button"
            onClick={onToggleAudioArmOrMute}
            class="tw-icon-btn"
            aria-label={audioArmed && !audioMuted ? 'Mute IEC 60601-1-8 alarm synthesizer' : 'Arm IEC 60601-1-8 alarm synthesizer'}
            title={audioArmed && !audioMuted ? 'Mute IEC 60601-1-8 alarms' : 'Arm IEC 60601-1-8 alarms'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4V5Z" />
              {audioArmed && !audioMuted ? (
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              ) : (
                <path d="m22 9-6 6M16 9l6 6" />
              )}
            </svg>
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            class="tw-icon-btn"
            aria-label={darkTheme ? 'Switch to light clinical paper theme' : 'Switch to dark ICU telemetry theme'}
            title={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              {darkTheme ? (
                <circle cx="12" cy="12" r="5" />
              ) : (
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              )}
            </svg>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('/cohort')}
            class="tw-icon-btn"
            aria-label="Open Cohort and Pro Exam Pass settings"
            title="Cohort & Exam Pass"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main 3-Pane Workspace: Dark Scope Sidebar (240px xl+ or 56px rail) + Fluid Main Canvas + Docked Inspector (360px xl+) */}
      <div class={`flex-1 min-h-0 grid ${workspaceGridCols}`}>
        {/* Dark Scope Sidebar */}
        <aside
          id="tw-scope-sidebar"
          aria-label="ICU Bed and Rhythm Scopes"
          class={`${mobileDrawerOpen ? 'flex' : 'hidden'} md:flex flex-col border-r ${sidebarCollapsed ? 'w-14 p-1.5' : 'p-3'} gap-4 overflow-y-auto`}
          style={{
            backgroundColor: 'var(--sidebar-bg)',
            color: 'var(--sidebar-text)',
            borderColor: 'var(--border)',
          }}
        >
          <div>
            {!sidebarCollapsed ? (
              <h2 class="text-sm font-semibold mb-2" style={{ color: 'var(--sidebar-text)' }}>
                Active ICU Beds
              </h2>
            ) : null}
            <ul class="list-none p-0 m-0 flex flex-col gap-1">
              {beds.map((bed) => {
                const isSelected = bed.bedIndex === selectedBedIndex;
                return (
                  <li key={bed.bedIndex}>
                    <button
                      type="button"
                      title={`${bed.bedLabel} (${bed.vitals.rhythm} · ${bed.vitals.hr} bpm)`}
                      onClick={() => {
                        onSelectBed(bed.bedIndex);
                        if (activeArea !== 'shift' && activeArea !== 'daily') {
                          onNavigate('/shift');
                        }
                      }}
                      class={`w-full min-h-10 text-left ${sidebarCollapsed ? 'px-1 justify-center' : 'px-3 justify-between'} py-2 rounded-md flex items-center text-sm`}
                      style={{
                        backgroundColor: isSelected ? 'var(--sidebar-active-bg)' : 'transparent',
                        color: 'var(--sidebar-text)',
                      }}
                    >
                      <span>{sidebarCollapsed ? `B${bed.bedIndex + 1}` : bed.bedLabel}</span>
                      {!sidebarCollapsed ? (
                        <span class="tw-mono-vital text-sm" style={{ color: 'var(--sidebar-muted)' }}>
                          {bed.vitals.rhythm} · {bed.vitals.hr}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div class="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            {!sidebarCollapsed ? (
              <h2 class="text-sm font-semibold mb-2" style={{ color: 'var(--sidebar-text)' }}>
                PTB-XL 12-Rhythm Bank
              </h2>
            ) : null}
            <ul class="list-none p-0 m-0 flex flex-col gap-1">
              <li>
                <button
                  type="button"
                  title="All Curated Strips"
                  onClick={() => onSelectRhythmFilter('ALL')}
                  class={`w-full min-h-10 text-left ${sidebarCollapsed ? 'px-1 justify-center' : 'px-3 justify-between'} py-1.5 rounded-md flex items-center text-sm`}
                  style={{
                    backgroundColor: activeRhythmFilter === 'ALL' ? 'var(--sidebar-active-bg)' : 'transparent',
                    color: 'var(--sidebar-text)',
                  }}
                >
                  <span>{sidebarCollapsed ? 'ALL' : 'All Curated Strips'}</span>
                  {!sidebarCollapsed ? (
                    <span class="tw-mono-vital" style={{ color: 'var(--sidebar-muted)' }}>
                      {records.length}
                    </span>
                  ) : null}
                </button>
              </li>
              {RHYTHM_CLASSES.map((rClass) => {
                const count = records.filter(
                  (r) => (!canAccessCase || canAccessCase(r)) && r.rhythmClass === rClass
                ).length;
                const active = activeRhythmFilter === rClass;
                return (
                  <li key={rClass}>
                    <button
                      type="button"
                      title={`${rClass} (${count} strips)`}
                      onClick={() => {
                        onSelectRhythmFilter(rClass);
                        const firstMatch = records.find(
                          (r) => (!canAccessCase || canAccessCase(r)) && r.rhythmClass === rClass
                        );
                        if (firstMatch && activeArea === 'caliper') {
                          onNavigate(`/caliper/${firstMatch.caseId}`);
                        }
                      }}
                      class={`w-full min-h-10 text-left ${sidebarCollapsed ? 'px-1 justify-center' : 'px-3 justify-between'} py-1.5 rounded-md flex items-center text-sm`}
                      style={{
                        backgroundColor: active ? 'var(--sidebar-active-bg)' : 'transparent',
                        color: 'var(--sidebar-text)',
                      }}
                    >
                      <span>{sidebarCollapsed ? rClass.slice(0, 3) : rClass}</span>
                      {!sidebarCollapsed ? (
                        <span class="tw-mono-vital" style={{ color: 'var(--sidebar-muted)' }}>
                          {count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/* Fluid Main Canvas Area */}
        <main class="min-w-0 p-4 flex flex-col gap-4 overflow-y-auto">{children}</main>

        {/* Docked Right Inspector: ACLS Causal Timeline & Hemodynamic Receipt / Fiducial Ground Truth */}
        <aside
          data-testid="causal-timeline-inspector"
          aria-label="Clinical Telemetry Inspector"
          class="border-t xl:border-t-0 xl:border-l p-4 overflow-y-auto"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          {inspectorContent}
        </aside>
      </div>
    </div>
  );
}
