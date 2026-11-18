// UI strings for the person-facing alert. Older adults in India often prefer
// Hindi; caregivers/ops screens stay in English. Add a language by adding a key.
// Wording rule: never claim more than the system knows — "may have fallen", and
// "help is coming" only once a caregiver has actually acknowledged.

export const LANGS = { en: 'English', hi: 'हिन्दी' };

export const STRINGS = {
  en: {
    speechLang: 'en-IN',
    alertTitle: 'Possible fall detected',
    alertBody: 'If you are OK, tap the button. Otherwise your caregiver will be alerted.',
    ok: "I'm OK — cancel",
    help: 'Get help now',
    seconds: (n) => `${n} seconds`,
    detectedBy: 'Sensor',
    supportsFall: 'supports a fall',
    disclaimer: 'Automatic alert — not a medical diagnosis.',
    say: 'Possible fall detected. If you are okay, press the button that says I am OK. Otherwise your caregiver will be alerted.',
    sayLeft: (n) => `${n} seconds left.`,
    sending: 'Contacting your caregiver…',
    sent: 'Your caregiver has been alerted',
    failed: 'Could not reach your caregiver — please call for help',
    ackBy: (name) => `${name} is responding`,
    waitingAck: 'Waiting for a caregiver to respond…',
    saySent: 'Your caregiver has been alerted.',
    sayAck: (name) => `${name} is responding.`,
    sayFailed: 'Could not reach your caregiver. Please call for help.',
    messageSent: 'Message sent to caregivers',
    done: 'Done',
  },
  hi: {
    speechLang: 'hi-IN',
    alertTitle: 'शायद आप गिर गए हैं',
    alertBody: 'अगर आप ठीक हैं तो बटन दबाइए। नहीं तो आपकी देखभाल करने वाले को सूचना दी जाएगी।',
    ok: 'मैं ठीक हूँ',
    help: 'अभी मदद चाहिए',
    seconds: (n) => `${n} सेकंड`,
    detectedBy: 'सेंसर',
    supportsFall: 'गिरने की पुष्टि करता है',
    disclaimer: 'यह स्वचालित सूचना है — चिकित्सा निदान नहीं।',
    say: 'शायद आप गिर गए हैं। अगर आप ठीक हैं, तो "मैं ठीक हूँ" वाला बटन दबाइए। नहीं तो आपकी देखभाल करने वाले को सूचना दी जाएगी।',
    sayLeft: (n) => `${n} सेकंड बाकी हैं।`,
    sending: 'आपकी देखभाल करने वाले से संपर्क हो रहा है…',
    sent: 'आपकी देखभाल करने वाले को सूचना दे दी गई है',
    failed: 'संपर्क नहीं हो पाया — कृपया मदद के लिए फ़ोन करें',
    ackBy: (name) => `${name} जवाब दे रहे हैं`,
    waitingAck: 'देखभाल करने वाले के जवाब का इंतज़ार…',
    saySent: 'आपकी देखभाल करने वाले को सूचना दे दी गई है।',
    sayAck: (name) => `${name} जवाब दे रहे हैं।`,
    sayFailed: 'संपर्क नहीं हो पाया। कृपया मदद के लिए फ़ोन करें।',
    messageSent: 'भेजा गया संदेश',
    done: 'ठीक है',
  },
};

export function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}
