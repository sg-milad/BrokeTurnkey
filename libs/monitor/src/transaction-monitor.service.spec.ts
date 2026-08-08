import { ConfigService } from '@nestjs/config';
import { TransactionMonitorService } from './transaction-monitor.service';
import { PendingMonitor } from './pending-monitor.service';

describe('TransactionMonitorService', () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    let mockPoll: jest.Mock;
    let pendingMonitor: PendingMonitor;

    let service: TransactionMonitorService;
    let configGet: jest.Mock;

    function makeService(interval: string | number = '15') {
        configGet = jest.fn().mockReturnValue(String(interval));
        const config = { get: configGet } as unknown as ConfigService;
        return new TransactionMonitorService(pendingMonitor, config);
    }

    beforeEach(() => {
        mockPoll = jest.fn().mockResolvedValue(undefined);
        pendingMonitor = { poll: mockPoll } as unknown as PendingMonitor;
        jest.clearAllMocks();
    });

    afterEach(() => {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    });

    describe('constructor', () => {
        it('reads poll interval from config', () => {
            service = makeService('30');

            expect(configGet).toHaveBeenCalledWith(
                'PENDING_POLL_INTERVAL_SECONDS',
                '15',
            );
            expect((service as any).pollIntervalSeconds).toBe(30);
        });

        it('falls back to 15 seconds when config omits the key', () => {
            // Real ConfigService returns the default value when the key is
            // missing; simulate that by returning '15'.
            configGet = jest.fn().mockReturnValue('15');
            const config = { get: configGet } as unknown as ConfigService;
            service = new TransactionMonitorService(pendingMonitor, config);
            expect(configGet).toHaveBeenCalledWith(
                'PENDING_POLL_INTERVAL_SECONDS',
                '15',
            );
            expect((service as any).pollIntervalSeconds).toBe(15);
        });
    });

    describe('onModuleInit', () => {
        it('sets an interval using pollIntervalSeconds and triggers first poll on the tick', () => {
            jest.useFakeTimers();
            const setIntervalSpy = jest.spyOn(global, 'setInterval');

            service = makeService('30');
            const logSpy = jest.spyOn((service as any).logger, 'log');

            service.onModuleInit();

            expect(logSpy).toHaveBeenCalledWith(
                'TransactionMonitorService: starting poller every 30s',
            );
            expect(setIntervalSpy).toHaveBeenCalledWith(
                expect.any(Function),
                30 * 1000,
            );

            jest.advanceTimersByTime(30 * 1000);
            expect(mockPoll).toHaveBeenCalled();

            jest.useRealTimers();
            setIntervalSpy.mockRestore();
        });
    });

    describe('triggerPoll', () => {
        it('runs a single poll cycle', async () => {
            service = makeService();

            await service.triggerPoll();

            expect(mockPoll).toHaveBeenCalledTimes(1);
        });

        it('does not rethrow when pendingMonitor.poll rejects', async () => {
            mockPoll.mockRejectedValue(new Error('boom'));
            service = makeService();

            const errorSpy = jest.spyOn((service as any).logger, 'error');

            await expect(service.triggerPoll()).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalledWith(
                'TransactionMonitorService: unhandled error in poll cycle: boom',
                expect.anything(),
            );
        });
    });
});