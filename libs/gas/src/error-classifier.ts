import { ErrorType } from './types';

/**
 * Classifies errors into retryable, permanent, or unknown categories.
 * This helps determine whether to retry an operation or fail fast.
 */
export function classifyError(error: Error): ErrorType {
    const message = error.message.toLowerCase();
    
    // Retryable: network/RPC issues
    if (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('econnrefused') ||
        message.includes('eai_again') ||
        message.includes('socket hang up')
    ) {
        return 'retryable';
    }
    
    // Permanent: transaction validation errors
    if (
        message.includes('insufficient funds') ||
        message.includes('nonce too low') ||
        message.includes('nonce too high') ||
        message.includes('replacement transaction underpriced') ||
        message.includes('already known') ||
        message.includes('intrinsic gas too low')
    ) {
        return 'permanent';
    }
    
    // Unknown: log for investigation
    return 'unknown';
}
