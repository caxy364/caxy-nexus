import React, { useState } from 'react';
import './AiBots.css';
import { FaPlay, FaRobot, FaChartLine, FaMagic, FaWaveSquare, FaPercent, FaHandPointUp, FaCoins, FaExchangeAlt, FaArrowUp, FaBrain, FaBalanceScale, FaRocket } from 'react-icons/fa';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useDevice } from '@deriv-com/ui';
import axios from 'axios';

const AiBots = observer(() => {
    const { load_modal, dashboard } = useStore();
    const { isDesktop, isTablet } = useDevice();
    const [loading, setLoading] = useState(false);

    const loadXMLToBotBuilder = (xml_string: string): void => {
        try {
            const strategy_id = window.Blockly.utils.idGenerator.genUid();

            window.Blockly.xmlValues = {
                block_string: xml_string,
                convertedDom: window.Blockly.utils.xml.textToDom(xml_string),
                file_name: 'freebot',
                from: 'my_computer',
                strategy_id,
            };

            if (load_modal?.loadStrategyOnBotBuilder) {
                load_modal.loadStrategyOnBotBuilder();
            } else {
                const workspace = window.Blockly.getMainWorkspace();
                workspace.clear();
                window.Blockly.Xml.domToWorkspace(window.Blockly.xmlValues.convertedDom, workspace);
                workspace.strategy_to_load = xml_string;
            }

            dashboard.setActiveTab(1);
        } catch (error) {
            console.error('Failed to load bot from XML:', error);
        }
    };

    const loadFreeBot = async (botFilename: string) => {
        setLoading(true);
        try {
            const response = await axios.get(`/${botFilename}`, { responseType: 'text' });
            await loadXMLToBotBuilder(response.data);
        } catch (error) {
            console.error(`Failed to fetch ${botFilename}`, error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            {loading && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <div className='bot-loader'></div>
                        <p>Please wait... </p>
                    </div>
                </div>
            )}

            <div className={`ai-bots-page ${loading ? 'blurred' : ''}`}>
                <div className='bots-listing-section'>
                     <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaBrain /> THE ORACLE BOT<span className='new-badge'>New!</span></h2>
                        <p className='ai-bot-description'>
                           Trades OVER/UNDER based on last 2 digits: OVER if below 3, UNDER if above 6. Customize predictions as needed.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('oracle.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaChartLine /> MASTERJET BOT</h2>
                        <p className='ai-bot-description'>
                           Rise/Fall bot that analyzes chart direction. Trades only on strong trends, skips neutral markets. Use low stakes for safety.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('masterjetai.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaHandPointUp /> UNDERPRO FULLY AUTO</h2>
                        <p className='ai-bot-description'>
                           Trades Under 7 when last 3 digits are 8 or 9. Uses Under 5 recovery after losses. Slow but reliable.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('underpro.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaArrowUp /> OVERMASTER FULLY AUTO</h2>
                        <p className='ai-bot-description'>
                           Trades Over 3 with Over 4 recovery. Waits for digit below 3, then confirms with Over 3. Slow but sure.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('overpro.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaWaveSquare /> WAVE RIDER A.I BOT</h2>
                        <p className='ai-bot-description'>
                           Automated Rise/Fall trader. Buys FALL after 3 rising moves, RISE after 3 falling moves. No analysis required.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('risefallai.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaPercent /> EVEN ODD PERCENTAGE BOT</h2>
                        <p className='ai-bot-description'>
                           Analyzes ticks for even/odd percentages. Trades based on threshold (e.g., ODD when above Y%). Use 1-tick duration, BOTH contract type.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('evenoddpc.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                     <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaHandPointUp /> TOUCH/NO TOUCH A.I</h2>
                        <p className='ai-bot-description'>
                           Touch/No Touch trader using candle colors and chart moves. Don't change barriers unless experienced.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('notouch.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaCoins /> PROFIT PILOT A.I</h2>
                        <p className='ai-bot-description'>
                           Over/Under with recovery. Set entry point (e.g., 2) to trade only when last digit matches. Slow but profitable.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('slowsure.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>
                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaExchangeAlt /> OVER UNDER AUTOSWITCH</h2>
                        <p className='ai-bot-description'>
                            Alternates Over/Under based on wins/losses. Adjust predictions and Martingale per risk tolerance.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('overunderai.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>

                     <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaArrowUp /> OVER 3 AUTO BOT v2</h2>
                        <p className='ai-bot-description'>
                            Checks digit sequence: trades if previous &lt; 3 and current &gt; 3. Adjust prediction digit as needed.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('over3.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>


                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaMagic /> AUTO C4 PREMIUM A.I</h2>
                        <p className='ai-bot-description'>
                            AI selects contract type and predictions. Just set stake, target profit, and run.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('autoc4.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>

                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaBalanceScale /> EVEN ODD FULLY AUTO</h2>
                        <p className='ai-bot-description'>
                            Reversed strategy: EVEN if last 4 digits odd, ODD if last 4 digits even.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('evenoddAI.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>

                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaRocket /> RISE FALL INDICATOR BOT</h2>
                        <p className='ai-bot-description'>
                            Uses moving averages and candle colors for Rise/Fall decisions. Best with 3-5 tick duration.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('riseindicator.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>

                    <div className='ai-bot-card'>
                        <h2 className='ai-bot-header'><FaExchangeAlt /> OVER UNDER - TITAN 5 BOT</h2>
                        <p className='ai-bot-description'>
                           Alternates Over/Under with split Martingale to minimize account blow-ups.
                        </p>
                        <button className='ai-bot-button' onClick={() => loadFreeBot('titanoverunder.xml')}>
                            <FaPlay /> Load this Bot
                        </button>
                    </div>

                    <h1 className='more-coming'>More coming.....</h1>
                </div>
            </div>
        </>
    );
});

export default AiBots;
