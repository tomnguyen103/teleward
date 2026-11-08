import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { RHYTHM_CLASSES, type AlarmPriority, type PtbxlCaseRecord, type RhythmClass } from '../types/teleward.ts';
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

/**
 * Renders the Calm 2-Region Default Shell with top command bar, collapsible scope rail, main canvas, and on-demand causal peek drawer.
 */
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
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [silenceRemainingSec, setSilenceRemainingSec] = useState(0);
  const mutedBySilenceRef = useRef(false);
  const prevSilenceSecRef = useRef(0);

  const toggleDesktopRail = () => {
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
  };

  const handleToggleRailOrDrawer = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileDrawerOpen((m) => !m);
      return;
    }
    toggleDesktopRail();
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (window.innerWidth < 768) {
          setMobileDrawerOpen((m) => !m);
        } else {
          toggleDesktopRail();
        }
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const silenceActive = silenceRemainingSec > 0;

  useEffect(() => {
    if (!silenceActive) return;
    const timer = setInterval(() => {
      setSilenceRemainingSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [silenceActive]);

  useEffect(() => {
    if (prevSilenceSecRef.current > 0 && silenceRemainingSec === 0) {
      if (mutedBySilenceRef.current && audioMuted) {
        onToggleAudioArmOrMute();
      }
      mutedBySilenceRef.current = false;
    }
    prevSilenceSecRef.current = silenceRemainingSec;
  }, [silenceRemainingSec, audioMuted, onToggleAudioArmOrMute]);

  const handleManualAudioToggle = () => {
    mutedBySilenceRef.current = false;
    if (silenceRemainingSec > 0) {
      setSilenceRemainingSec(0);
    }
    onToggleAudioArmOrMute();
  };

  let highestPriority: AlarmPriority = 'NORMAL';
  for (const b of beds) {
    if (b.alarmPriority === 'CRISIS') {
      highestPriority = 'CRISIS';
      break;
    }
    if (b.alarmPriority === 'WARNING') {
      highestPriority = 'WARNING';
    }
  }

  const beaconClass =
    highestPriority === 'CRISIS'
      ? 'tw-beacon-crisis'
      : highestPriority === 'WARNING'
        ? 'tw-beacon-warning'
        : 'tw-beacon-normal';

  const handleToggleSilence120s = () => {
    if (silenceRemainingSec > 0) {
      mutedBySilenceRef.current = false;
      setSilenceRemainingSec(0);
      if (audioMuted) {
        onToggleAudioArmOrMute();
      }
    } else {
      setSilenceRemainingSec(120);
      if (audioArmed && !audioMuted) {
        mutedBySilenceRef.current = true;
        onToggleAudioArmOrMute();
      } else {
        mutedBySilenceRef.current = false;
      }
    }
  };

  const navItems: Array<{ area: ActiveRouteArea; label: string; shortLabel: string; href: string }> = [
    { area: 'shift', label: 'Shift Station', shortLabel: 'SS', href: '/shift' },
    { area: 'daily', label: 'Daily Seed', shortLabel: 'DS', href: '/daily' },
    { area: 'caliper', label: 'Calipers', shortLabel: '12L', href: '/caliper/ptbxl-001' },
    { area: 'cohort', label: 'Cohort Pro', shortLabel: 'PRO', href: '/cohort' },
  ];

  const COMPACT_RHYTHM_ABBREV: Record<RhythmClass, string> = {
    NSR: 'NSR',
    SB: 'SBR',
    SVT: 'SVT',
    AFIB: 'AFB',
    AFLT: 'AFL',
    AVB3: 'AV3',
    VT_MONO: 'VTM',
    TORSADES: 'TDP',
    VFIB: 'VFB',
    ASYSTOLE: 'ASY',
    PEA: 'PEA',
    STEMI_ANT: 'STM',
  };

  const isRailExpanded = isMobileViewport ? mobileDrawerOpen : !sidebarCollapsed;
  const showFullRailLabels = isRailExpanded;

  const workspaceGridCols = sidebarCollapsed
    ? 'grid-cols-1 md:grid-cols-[56px_minmax(0,1fr)]'
    : 'grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]';

  return (
    <div class="min-h-screen flex flex-col tw-app-root">
      {/* Unified Single 64px Sticky Top Bar */}
      <header class="sticky top-0 z-30 min-h-16 py-1.5 sm:py-0 sm:h-16 px-3 sm:px-4 border-b flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 tw-topbar">
        <div class="flex items-center gap-2.5 min-w-0 shrink-0">
          <button
            type="button"
            data-testid="sidebar-collapse-toggle"
            onClick={handleToggleRailOrDrawer}
            aria-expanded={isRailExpanded}
            aria-controls="tw-scope-sidebar"
            aria-label={isRailExpanded ? 'Collapse Scope Rail (Ctrl+B)' : 'Expand Scope Rail (Ctrl+B)'}
            title="Toggle Scope Rail (Ctrl+B)"
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
            class="h-10 flex items-center gap-2 font-semibold text-base no-underline shrink-0 tw-brand-link"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="tw-brand-icon">
              <path d="M2 12h4l3-8 4 16 3-8h6" />
            </svg>
            <span class="hidden sm:inline">TeleWard</span>
          </a>

          <nav aria-label="Primary Workspace Navigation" class="hidden xl:flex items-center gap-0.5 h-16">
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
                  class={`h-16 px-2.5 2xl:px-3 inline-flex items-center text-sm font-medium no-underline transition-colors whitespace-nowrap ${
                    isActive ? 'tw-nav-link-active' : 'tw-nav-link'
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </div>

        {/* Center Instrument Strip: Quick Strip Search + Embedded IEC 60601-1-8 Alarm Beacon & Silence Countdown */}
        <div class="flex items-center gap-1.5 sm:gap-2 min-w-0 justify-center">
          <div class="w-36 xl:w-44 2xl:w-56 hidden lg:block">
            <label htmlFor="tw-global-search" class="sr-only">
              Search PTB-XL strips
            </label>
            <div class="flex items-center px-2.5 py-1 h-10 rounded-md tw-search-box">
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
                placeholder="Search strips (Ctrl+K)"
                class="w-full h-10 bg-transparent border-0 text-sm focus:outline-none tw-brand-link"
              />
            </div>
          </div>

          <div
            data-testid="audio-arm-banner"
            class="min-h-10 px-2.5 py-1 rounded-md flex items-center gap-1.5 text-sm shrink-0 tw-search-box"
          >
            <span class={`tw-mono-vital px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ${beaconClass}`}>
              <span class="hidden md:inline">IEC 60601-1-8 · </span>
              {highestPriority}
            </span>

            <button
              type="button"
              data-testid="arm-audio-btn"
              onClick={handleManualAudioToggle}
              class={`min-h-10 px-2.5 hidden md:inline-flex items-center text-xs font-semibold rounded whitespace-nowrap ${
                audioArmed && !audioMuted ? 'tw-audio-pill-armed' : 'tw-audio-pill'
              }`}
            >
              {!audioArmed ? 'Arm Audio' : audioMuted ? 'Audio Muted' : 'Audio Armed'}
            </button>

            <button
              type="button"
              data-testid="alarm-silence-120s-btn"
              onClick={handleToggleSilence120s}
              class={`min-h-10 px-2.5 inline-flex items-center tw-mono-vital text-xs font-semibold rounded whitespace-nowrap ${
                silenceRemainingSec > 0 ? 'tw-silence-pill-active' : 'tw-silence-pill'
              }`}
              title="Silence IEC 60601-1-8 audible alarms for 120 seconds"
            >
              {silenceRemainingSec > 0 ? (
                `Audio Paused (${silenceRemainingSec}s)`
              ) : (
                <>
                  <span class="hidden sm:inline">Silence&nbsp;</span>120s
                </>
              )}
            </button>

            {cohortBannerText ? (
              <span class="hidden sm:inline-flex px-2 py-1 rounded text-xs tw-mono-vital whitespace-nowrap tw-surface">
                {cohortBannerText}
              </span>
            ) : null}
          </div>
        </div>

        {/* Right Contiguous Action Cluster (40x40 square icon buttons, 8px gap, zero text between icons) */}
        <div class="flex items-center gap-2 shrink-0" role="toolbar" aria-label="Station Controls">
          <button
            type="button"
            onClick={handleManualAudioToggle}
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
            data-testid="toggle-causal-drawer-btn"
            onClick={() => setInspectorOpen((o) => !o)}
            aria-expanded={inspectorOpen}
            aria-controls="tw-causal-peek-drawer"
            aria-label="Toggle Causal Timeline Drawer"
            title="Causal Log"
            class="tw-icon-btn"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('/cohort/roster')}
            class="tw-icon-btn"
            aria-label="Open Cohort Pro settings"
            title="Cohort Pro"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </button>
        </div>
      </header>

      {/* Calm 2-Region Default Shell: Collapsible Left Scope Rail + Focused Main Canvas */}
      <div class={`flex-1 min-h-0 grid relative ${workspaceGridCols}`}>
        {/* Region 1: Dark Scope Rail */}
        <aside
          id="tw-scope-sidebar"
          aria-label="ICU Bed and Rhythm Scopes"
          class={`${
            mobileDrawerOpen ? 'flex w-60 p-3' : 'hidden'
          } md:flex flex-col border-r ${
            sidebarCollapsed ? 'md:w-14 md:p-1.5' : 'md:w-60 md:p-3'
          } gap-4 overflow-y-auto tw-sidebar`}
        >
          {/* All-Viewport Workbench Route Switcher */}
          <div>
            {showFullRailLabels ? (
              <h2 class="text-sm font-semibold mb-2 tw-sidebar-heading">Workbench</h2>
            ) : null}
            <ul class="list-none p-0 m-0 flex flex-col gap-1">
              {navItems.map((item) => {
                const isActive = activeArea === item.area;
                return (
                  <li key={item.area}>
                    <a
                      href={item.href}
                      title={item.label}
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(item.href);
                        setMobileDrawerOpen(false);
                      }}
                      aria-current={isActive ? 'page' : undefined}
                      class={`w-full min-h-10 no-underline ${
                        showFullRailLabels ? 'px-2.5 justify-between' : 'px-1 justify-center'
                      } py-2 rounded-md flex items-center text-sm font-medium ${
                        isActive ? 'tw-sidebar-item-active' : 'tw-sidebar-item'
                      }`}
                    >
                      <span>{showFullRailLabels ? item.label : item.shortLabel}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Active Ward Beds (Shift & Daily routes only) */}
          {activeArea === 'shift' || activeArea === 'daily' ? (
            <div class="border-t pt-3 tw-border">
              {showFullRailLabels ? (
                <h2 class="text-sm font-semibold mb-2 tw-sidebar-heading">Ward Beds</h2>
              ) : null}
              <ul class="list-none p-0 m-0 flex flex-col gap-1">
                {beds.map((bed) => {
                  const isSelected = bed.bedIndex === selectedBedIndex;
                  const badgeClass =
                    bed.alarmPriority === 'CRISIS'
                      ? 'tw-beacon-crisis'
                      : bed.alarmPriority === 'WARNING'
                        ? 'tw-beacon-warning'
                        : 'tw-beacon-normal';
                  return (
                    <li key={bed.bedIndex}>
                      <button
                        type="button"
                        title={`${bed.bedLabel} (${bed.vitals.rhythm} · ${bed.vitals.hr} bpm)`}
                        onClick={() => {
                          onSelectBed(bed.bedIndex);
                        }}
                        class={`w-full min-h-10 text-left ${
                          showFullRailLabels ? 'px-2.5 justify-between' : 'px-1 justify-center'
                        } py-2 rounded-md flex items-center text-sm ${
                          isSelected ? 'tw-sidebar-item-active' : 'tw-sidebar-item'
                        }`}
                      >
                        <span class="font-medium">
                          {showFullRailLabels ? bed.bedLabel : `B${bed.bedIndex + 1}`}
                        </span>
                        {showFullRailLabels ? (
                          <span class="flex items-center gap-1.5">
                            <span class={`tw-mono-vital px-1.5 py-0.5 rounded text-xs font-semibold ${badgeClass}`}>
                              {bed.vitals.rhythm}
                            </span>
                            <span class="tw-mono-vital text-xs tw-sidebar-muted">
                              {bed.vitals.hr}
                            </span>
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* PTB-XL 12-Rhythm Class Filter (Caliper route only) */}
          {activeArea === 'caliper' ? (
            <div class="border-t pt-3 tw-border">
              {showFullRailLabels ? (
                <h2 class="text-sm font-semibold mb-2 tw-sidebar-heading">Rhythm Class</h2>
              ) : null}
              <ul class="list-none p-0 m-0 flex flex-col gap-1">
                <li>
                  <button
                    type="button"
                    title="All Curated Records"
                    onClick={() => onSelectRhythmFilter('ALL')}
                    class={`w-full min-h-10 text-left ${
                      showFullRailLabels ? 'px-3 justify-between' : 'px-1 justify-center'
                    } py-1.5 rounded-md flex items-center text-sm ${
                      activeRhythmFilter === 'ALL' ? 'tw-sidebar-item-active' : 'tw-sidebar-item'
                    }`}
                  >
                    <span>{showFullRailLabels ? 'All Records' : 'ALL'}</span>
                    {showFullRailLabels ? (
                      <span class="tw-mono-vital text-xs tw-sidebar-muted">
                        {(() => {
                          const unlockedCount = records.filter((r) => !canAccessCase || canAccessCase(r)).length;
                          return unlockedCount === records.length
                            ? String(records.length)
                            : `${unlockedCount}/${records.length}`;
                        })()}
                      </span>
                    ) : null}
                  </button>
                </li>
                {RHYTHM_CLASSES.map((rClass) => {
                  const totalForClass = records.filter((r) => r.rhythmClass === rClass).length;
                  const count = records.filter(
                    (r) => (!canAccessCase || canAccessCase(r)) && r.rhythmClass === rClass
                  ).length;
                  const active = activeRhythmFilter === rClass;
                  return (
                    <li key={rClass}>
                      <button
                        type="button"
                        title={`${rClass} (${count} of ${totalForClass} strips unlocked)`}
                        onClick={() => {
                          onSelectRhythmFilter(rClass);
                          const firstMatch = records.find(
                            (r) => (!canAccessCase || canAccessCase(r)) && r.rhythmClass === rClass
                          );
                          if (firstMatch) {
                            onNavigate(`/caliper/${firstMatch.caseId}`);
                          }
                        }}
                        class={`w-full min-h-10 text-left ${
                          showFullRailLabels ? 'px-3 justify-between' : 'px-1 justify-center'
                        } py-1.5 rounded-md flex items-center text-sm ${
                          active ? 'tw-sidebar-item-active' : 'tw-sidebar-item'
                        }`}
                      >
                        <span>{showFullRailLabels ? rClass : COMPACT_RHYTHM_ABBREV[rClass]}</span>
                        {showFullRailLabels ? (
                          <span class="tw-mono-vital text-xs tw-sidebar-muted">
                            {count === totalForClass ? count : `${count}/${totalForClass}`}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* Cohort Views (Cohort route only) */}
          {activeArea === 'cohort' ? (
            <div class="border-t pt-3 tw-border">
              {showFullRailLabels ? (
                <h2 class="text-sm font-semibold mb-2 tw-sidebar-heading">Cohort Views</h2>
              ) : null}
              <ul class="list-none p-0 m-0 flex flex-col gap-1">
                {[
                  { label: 'Overview', short: 'OV', href: '/cohort/overview' },
                  { label: 'Cohort Roster', short: 'RS', href: '/cohort/roster' },
                  { label: 'Receipt Verifier', short: 'VF', href: '/cohort/assign' },
                  { label: 'Pro Access', short: 'PA', href: '/cohort/billing' },
                ].map((sub) => (
                  <li key={sub.href}>
                    <a
                      href={sub.href}
                      title={sub.label}
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(sub.href);
                        setMobileDrawerOpen(false);
                      }}
                      class={`w-full min-h-10 no-underline ${
                        showFullRailLabels ? 'px-2.5 justify-between' : 'px-1 justify-center'
                      } py-2 rounded-md flex items-center text-sm font-medium tw-sidebar-item`}
                    >
                      <span>{showFullRailLabels ? sub.label : sub.short}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        {/* Region 2: Focused Main Canvas Area */}
        <main class="min-w-0 p-4 flex flex-col gap-4 overflow-y-auto">{children}</main>

        {/* On-Demand Slide-Over Causal Peek Drawer (Always mounted in DOM for instant inspection) */}
        <aside
          id="tw-causal-peek-drawer"
          data-testid="causal-timeline-inspector"
          aria-label="Clinical Telemetry Inspector"
          aria-hidden={inspectorOpen ? 'false' : 'true'}
          class={`${
            inspectorOpen ? 'flex' : 'hidden'
          } fixed top-16 right-0 bottom-0 z-20 w-88 max-w-full border-l p-4 flex-col gap-3 overflow-y-auto tw-peek-drawer`}
        >
          <div class="flex items-center justify-between pb-2 border-b tw-border">
            <span class="text-xs font-semibold tw-text-muted">Causal Audit Log</span>
            <button
              type="button"
              onClick={() => setInspectorOpen(false)}
              class="tw-btn-secondary min-h-10 text-xs px-3"
            >
              Close Log
            </button>
          </div>
          {inspectorContent}
        </aside>
      </div>
    </div>
  );
}
