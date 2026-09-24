import React, { useEffect, useState } from 'react';

import { useStore } from '@/hooks/useStore';

import './Customdash.css';
import Dualbot from './Dualbot';
import DualHighLowTicks from './DualHighLowTicks';
import DualHigherLower from './DualHigherLower';
import EliteFlow from './EliteFlow';
import Higherlower from './Higherlower';
import PairedBot from './PairedBot/PairedBot';
import SignalHub from './Oracle';

const CustomDash = () => {
    const { dashboard } = useStore();
    const [activeTab, setActiveTab] = useState(dashboard?.selected_signal_component || 'oracle');

    const tabs = [
        { id: 'oracle', label: 'The Oracle', component: <SignalHub /> },
        { id: 'elite', label: 'Elite Flow', component: <EliteFlow/> },
        { id: 'hedge', label: 'Over5/Under4', component: <Dualbot/> },
        { id: 'dual-higher-lower', label: 'Dual Higher/Lower', component: <DualHigherLower /> },
        { id: 'dual-high-low-ticks', label: 'Dual High/Low Ticks', component: <DualHighLowTicks /> },
        { id: 'updown', label: 'Up/Down', component: <Higherlower /> },
        { id: 'paired', label: 'In / Out', component: <PairedBot /> },
    ];

    useEffect(() => {
        dashboard?.setSelectedSignalComponent?.(activeTab);
    }, [activeTab, dashboard]);

    useEffect(() => {
        const selectedComponent = dashboard?.selected_signal_component;
        if (selectedComponent && selectedComponent !== activeTab) {
            setActiveTab(selectedComponent);
        }
    }, [activeTab, dashboard?.selected_signal_component]);

    return (
        <div className='dash-container'>
            <div className='tab-wrapper'>
                <div className='tab-scroll-container'>
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className='tab-view-area'>{tabs.find(t => t.id === activeTab)?.component}</div>
        </div>
    );
};

export default CustomDash;
