type TTabsTitle = {
    [key: string]: string | number;
};

type TDashboardTabIndex = {
    [key: string]: number;
};

export const tabs_title: TTabsTitle = Object.freeze({
    WORKSPACE: 'Workspace',
    CHART: 'Chart',
});

export const DBOT_TABS: TDashboardTabIndex = Object.freeze({
    DASHBOARD: 0,
    BOT_BUILDER: 1,
    OVERLORD: 2,
    ELITE_PRIME: 3,
    SIGNALS: 4,
    BOTS: 5,
    SMART_TRADER: 6,
    CHART: 7,
    TUTORIALS: 8,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
    'id-overlord',
    'id-elite-prime',
    'id-signals',
    'id-bots',
    'id-smart-trader',
    'id-charts',
    'id-tutorials',
];

export const DEBOUNCE_INTERVAL_TIME = 500;
