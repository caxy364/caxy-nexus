import { localize } from '@deriv-com/translations';
import { config } from '../constants/config';

const isTruthyFlag = value => value === 1 || value === true || value === '1';

export const isContractClosed = contract => {
    const normalized_status = String(contract?.status || '').toLowerCase();

    return Boolean(
        (normalized_status && normalized_status !== 'open') ||
        isTruthyFlag(contract?.is_sold) ||
        isTruthyFlag(contract?.is_expired) ||
        isTruthyFlag(contract?.is_settleable) ||
        contract?.sell_time
    );
};

// TODO: use-shared-functions - These functions are duplicates of trader ones, export and use these instead.
export const getContractTypeName = contract => {
    if (!contract || !contract.contract_type) {
        return localize('Unknown');
    }

    const { opposites } = config();
    let name = localize('Unknown');

    Object.keys(opposites).forEach(opposites_name => {
        const contract_type_objs = opposites[opposites_name];

        contract_type_objs.forEach(contract_type_obj => {
            const contract_type_names = Object.entries(contract_type_obj)[0]; // ['CALL', 'Rise']

            if (contract_type_names[0] === contract.contract_type) {
                // Extra check for CALL & PUT types to distinguish Rise/Fall & Higher/Lower.
                if (['CALL', 'PUT'].includes(contract_type_names[0])) {
                    const has_shortcode = typeof contract.shortcode === 'string' && contract.shortcode.length > 0;
                    const shortcode_suffix = has_shortcode ? contract.shortcode.split('_').slice(-2)[0] : '';
                    const is_risefall = has_shortcode ? /^S0P$/.test(shortcode_suffix) : true;
                    const req_opposite_name = is_risefall ? 'CALLPUT' : 'HIGHERLOWER';

                    if (opposites_name !== req_opposite_name) {
                        return;
                    }
                }

                name = contract_type_names[1];
            }
        });
    });

    return name;
};
