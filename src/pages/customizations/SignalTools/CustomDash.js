import React, { useEffect, useState } from 'react';

import { useStore } from '@/hooks/useStore';

import './Customdash.css';
import Dualbot from './Dualbot';
import EliteFlow from './EliteFlow';
import Higherlower from './Higherlower';
import SignalHub from './Oracle';

// Dummy Components for now


const CustomDash = () => {
    const { dashboard } = useStore();
    const [activeTab, setActiveTab] = useState(dashboard?.selected_signal_component || 'oracle');

    const tabs = [
        { id: 'oracle', label: 'The Oracle', component: <SignalHub /> },
        { id: 'elite', label: 'Elite Flow', component: <EliteFlow/> },
        { id: 'hedge', label: 'Over5/Under4', component: <Dualbot/> },
        { id: 'updown', label: 'Up/Down', component: <Higherlower /> },
       
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
            {/* Scrollable Tab Bar */}
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

            {/* Dynamic Content Area */}
            <div className='tab-view-area'>{tabs.find(t => t.id === activeTab)?.component}</div>
        </div>
    );
};

export default CustomDash;
