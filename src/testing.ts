import { EventType, Event, Push, Throw, End, Source, Sink } from './source';
import { Subject as DefaultSubject } from './subject';
import { Disposable } from './disposable';

interface TestScheduleFunction {
    (
        callback: () => void,
        delayFrames: number,
        subscription?: Disposable,
    ): void;
}

export interface TestSchedule extends TestScheduleFunction {
    readonly currentFrame: number;
    readonly flush: () => void;
    readonly reset: () => void;
}

interface TestScheduleAction {
    readonly callback: () => void;
    readonly executionFrame: number;
    shouldCall: boolean;
}

export function TestSchedule(): TestSchedule {
    const actions: TestScheduleAction[] = [];
    let currentFrame = 0;
    let isFlushing = false;

    const testSchedule: TestScheduleFunction = (
        callback,
        delayFrames,
        subscription,
    ) => {
        if (subscription?.active === false) {
            return;
        }

        const executionFrame = currentFrame + delayFrames;
        const index = getActionInsertIndex(actions, executionFrame);
        const action: TestScheduleAction = {
            callback,
            executionFrame,
            shouldCall: true,
        };

        actions.splice(index, 0, action);
        subscription?.add(
            Disposable(() => {
                action.shouldCall = false;
            }),
        );
    };

    Object.defineProperty(testSchedule, 'currentFrame', {
        enumerable: true,
        get: (): number => currentFrame,
    });

    function flush(): void {
        if (isFlushing) {
            return;
        }

        isFlushing = true;
        let action = actions.shift();
        while (action) {
            currentFrame = action.executionFrame;
            const { callback, shouldCall } = action;

            if (shouldCall) {
                try {
                    callback();
                } catch (error) {
                    reset();
                    throw error;
                }
            }

            action = actions.shift();
        }
        isFlushing = false;
    }

    Object.defineProperty(testSchedule, 'flush', {
        value: flush,
    });

    function reset(): void {
        actions.length = 0;
        currentFrame = 0;
        // If reset mid-execution.
        isFlushing = false;
    }

    Object.defineProperty(testSchedule, 'reset', {
        value: reset,
    });

    return testSchedule as TestSchedule;
}

function getActionInsertIndex(
    actions: TestScheduleAction[],
    frame: number,
): number {
    const len = actions.length;
    let low = 0;
    let high = len - 1;

    while (low <= high) {
        let mid = ((low + high) / 2) | 0;
        const { executionFrame } = actions[mid];

        if (executionFrame < frame) {
            low = mid + 1;
        } else if (executionFrame > frame) {
            high = mid - 1;
        } else {
            while (mid + 1 < len && actions[mid + 1].executionFrame === frame) {
                mid++;
            }
            return mid + 1;
        }
    }

    if (high < 0) {
        return 0; // frame < first frame
    } else if (low > len - 1) {
        return len; // frame >= last frame
    } else {
        return low < high ? low + 1 : high + 1;
    }
}

export interface TestSubscriptionInfo {
    subscriptionStartFrame: number;
    subscriptionEndFrame: number;
}

export function TestSubscriptionInfo(
    subscriptionStartFrame: number,
    subscriptionEndFrame: number,
): TestSubscriptionInfo {
    return { subscriptionStartFrame, subscriptionEndFrame };
}

function watchSubscriptionInfo(
    testSchedule: TestSchedule,
    subscription?: Disposable,
): TestSubscriptionInfo {
    const info: TestSubscriptionInfo = TestSubscriptionInfo(
        testSchedule.currentFrame,
        Infinity,
    );

    subscription?.add(
        Disposable(() => {
            info.subscriptionEndFrame = testSchedule.currentFrame;
        }),
    );

    return info;
}

export type TestSourceSubscriptions = ReadonlyArray<
    Readonly<TestSubscriptionInfo>
>;

interface WithFrameProperty {
    readonly frame: number;
}

export type TestSourceEvent<T> = Event<T> & WithFrameProperty;

export function P<T>(value: T, frame: number): Push<T> & WithFrameProperty {
    return { type: EventType.Push, value, frame };
}

export function T(error: unknown, frame: number): Throw & WithFrameProperty {
    return { type: EventType.Throw, error, frame };
}

export function E(frame: number): End & WithFrameProperty {
    return { type: EventType.End, frame };
}

export interface TestSource<T> extends Source<T> {
    readonly subscriptions: TestSourceSubscriptions;
}

export function TestSource<T>(
    events: TestSourceEvent<T>[],
    testSchedule: TestSchedule,
): TestSource<T> {
    const subscriptions: TestSubscriptionInfo[] = [];

    const base = Source<T>((sink) => {
        subscriptions.push(watchSubscriptionInfo(testSchedule, sink));
        events.forEach((event) => {
            testSchedule(() => sink(event), event.frame, sink);
        });
    });

    Object.defineProperty(base, 'subscriptions', {
        enumerable: true,
        get: (): TestSourceSubscriptions => subscriptions,
    });

    return base as TestSource<T>;
}

export interface SharedTestSource<T> extends TestSource<T> {
    readonly schedule: (subscription?: Disposable) => void;
}

export function SharedTestSource<T>(
    events: TestSourceEvent<T>[],
    testSchedule: TestSchedule,
    Subject = DefaultSubject,
): SharedTestSource<T> {
    const subscriptions: TestSubscriptionInfo[] = [];
    const subject = Subject<T>();

    const base = Source<T>((sink) => {
        subscriptions.push(watchSubscriptionInfo(testSchedule, sink));
        subject(sink);
    });

    Object.defineProperty(base, 'subscriptions', {
        enumerable: true,
        get: (): TestSourceSubscriptions => subscriptions,
    });

    Object.defineProperty(base, 'schedule', {
        value: (subscription?: Disposable): void => {
            events.forEach((event) => {
                testSchedule(() => subject(event), event.frame, subscription);
            });
        },
    });

    return base as SharedTestSource<T>;
}

export function watchSourceEvents<T>(
    source: Source<T>,
    testSchedule: TestSchedule,
    subscriptionInfo: TestSubscriptionInfo = watchSubscriptionInfo(
        testSchedule,
    ),
): TestSourceEvent<T>[] {
    const subscription = Disposable();
    const events: TestSourceEvent<T>[] = [];

    testSchedule(() => {
        source(
            Sink((event) => {
                events.push({ ...event, frame: testSchedule.currentFrame });
            }, subscription),
        );
    }, subscriptionInfo.subscriptionStartFrame);

    testSchedule(() => {
        subscription.dispose();
    }, subscriptionInfo.subscriptionEndFrame);

    return events;
}
