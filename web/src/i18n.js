// UI strings for the person-facing alert. Older adults in India often prefer
// Hindi; caregivers/ops screens stay in English. Add a language by adding a key.

export const LANGS = { en: 'English', hi: 'हिन्दी' };

export const STRINGS = {
  en: {
    speechLang: 'en-IN',
    alertTitle: 'Possible fall detected',
    alertBody: 'If you are OK, tap the button. Otherwise your caregiver will be alerted.',
    ok: "I'm OK — cancel",
    help: 'Get help now',
    seconds: (n) => `${n} seconds`,
    detectedBy: 'Detected by',
    say: 'Possible fall detected. If you are okay, press I am OK. Otherwise your caregiver will be alerted.',
    sayLeft: (n) => `${n} seconds left.`,
    notifiedTitle: 'Your caregiver has been alerted',
    ackBy: (name) => `${name} is responding`,
    waitingAck: 'Waiting for a caregiver to respond…',
    sayNotified: 'Your caregiver has been alerted. Help is on the way.',
    done: 'Done',
  },
  hi: {
    speechLang: 'hi-IN',
    alertTitle: 'गिरने का पता चला है',
    alertBody: 'अगर आप ठीक हैं तो बटन दबाइए। नहीं तो आपके देखभाल करने वाले को सूचना दी जाएगी।',
    ok: 'मैं ठीक हूँ',
    help: 'अभी मदद चाहिए',
    seconds: (n) => `${n} सेकंड`,
    detectedBy: 'पता चला',
    say: 'क्या आप गिर गए हैं? अगर आप ठीक हैं, तो मैं ठीक हूँ बटन दबाइए। नहीं तो आपके देखभाल करने वाले को सूचना दी जाएगी।',
    sayLeft: (n) => `${n} सेकंड बाकी हैं।`,
    notifiedTitle: 'आपके देखभाल करने वाले को सूचना दे दी गई है',
    ackBy: (name) => `${name} मदद के लिए आ रहे हैं`,
    waitingAck: 'देखभाल करने वाले के जवाब का इंतज़ार…',
    sayNotified: 'आपके देखभाल करने वाले को सूचना दे दी गई है। मदद आ रही है।',
    done: 'ठीक है',
  },
};

export function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}
