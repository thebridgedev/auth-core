/**
 * Message catalogue for the SDK auth components (TBP-630).
 *
 * Lives in auth-core, not in a framework package, so bridge-svelte, -react,
 * -angular and -nextjs resolve identical copy instead of drifting into four
 * slightly different logins. The strings are framework-agnostic; only the
 * rendering is not.
 *
 * ## Where the line sits
 *
 * Bridge owns the MECHANICS and translates them: what a field is, what a button
 * does, what went wrong, what succeeded. Those are facts about how the auth flow
 * works, identical for every tenant, and no consuming app should be rewriting
 * them.
 *
 * The consuming app owns VOICE and CONTEXT: the page title, the subtitle,
 * anything naming the product or explaining why the user is on this screen.
 * Bridge cannot know those — hence `heading={null}` / `description={null}`
 * (TBP-631) rather than catalogue entries.
 *
 * ## Keys are flat and dotted
 *
 * `login.email`, not a nested object. A flat map makes the override prop a
 * plain `Partial<Messages>`, keeps lookup a single property access with no
 * traversal, and means a typo in a key is a TypeScript error rather than a
 * silent `undefined` at render time.
 */

/** Every user-facing string the SDK auth components render. */
export interface Messages {
  // Shared field labels + controls
  'field.email': string;
  'field.password': string;
  'field.newPassword': string;
  'field.confirmPassword': string;
  'field.firstName': string;
  'field.lastName': string;
  'field.phoneNumber': string;
  'field.verificationCode': string;
  'field.authenticationCode': string;
  'field.recoveryCode': string;
  'placeholder.email': string;
  'placeholder.password': string;
  'placeholder.newPassword': string;
  'placeholder.confirmPassword': string;
  'placeholder.firstName': string;
  'placeholder.lastName': string;
  'placeholder.phoneNumber': string;
  'placeholder.sixDigitCode': string;
  'placeholder.recoveryCode': string;
  'action.showPassword': string;
  'action.hidePassword': string;
  'action.showPasswords': string;
  'action.hidePasswords': string;
  'action.backToLogin': string;
  'action.backToSignIn': string;
  'action.resendCode': string;
  'action.copy': string;
  'action.copied': string;
  'action.tryAgain': string;
  'action.done': string;
  /** The "or" rule between the password form and the alternative methods. */
  'divider.or': string;

  // Login
  'login.heading': string;
  'login.submit': string;
  /** In-flight label on the login button. */
  'login.submitting': string;
  'login.forgotPassword': string;
  'login.magicLink': string;
  'login.signupPrompt': string;
  'login.signupLink': string;
  'login.error.invalidCredentials': string;

  // Forgot / set password
  'forgot.headingRequest': string;
  'forgot.headingSet': string;
  'forgot.description': string;
  'forgot.submit': string;
  'forgot.setSubmit': string;
  'forgot.emailSent': string;
  'forgot.successHeading': string;
  'forgot.error.send': string;
  'forgot.error.update': string;
  'forgot.error.mismatch': string;
  'forgot.error.tooShort': string;

  // Magic link
  'magicLink.heading': string;
  'magicLink.description': string;
  'magicLink.submit': string;
  /** Interpolates {expiry}, already formatted by the four keys below. */
  'magicLink.sent': string;
  /** Interpolates {count}. Split singular/plural because English needs both. */
  'magicLink.expiryMinute': string;
  'magicLink.expiryMinutes': string;
  'magicLink.expirySeconds': string;
  'magicLink.error.send': string;
  'magicLink.error.auth': string;

  // Signup
  'signup.heading': string;
  'signup.submit': string;
  'signup.successHeading': string;
  /** Interpolates {email}. */
  'signup.successDescription': string;
  'signup.loginPrompt': string;
  'signup.loginLink': string;
  'signup.error.create': string;

  // Passkeys
  'passkey.loginButton': string;
  'passkey.createHeading': string;
  'passkey.createPrompt': string;
  'passkey.createLink': string;
  'passkey.requestDescription': string;
  'passkey.requestSubmit': string;
  'passkey.sentHeading': string;
  /** Interpolates {email}. */
  'passkey.sentDescription': string;
  /** Heading while the browser ceremony is in flight. */
  'passkey.settingUpHeading': string;
  /** Heading once the ceremony has failed. */
  'passkey.setupHeading': string;
  'passkey.signInNow': string;
  'passkey.requestNewLink': string;
  'passkey.setupDescription': string;
  'passkey.setupSuccessHeading': string;
  'passkey.setupSuccessDescription': string;
  'passkey.error.cancelled': string;
  /** Login ceremony aborted — distinct from `cancelled`, which is setup. */
  'passkey.error.authCancelled': string;
  'passkey.error.setupFailed': string;
  'passkey.error.expired': string;
  'passkey.error.unsupported': string;
  'passkey.error.auth': string;
  'passkey.error.setup': string;
  'passkey.error.verify': string;
  'passkey.error.sendLink': string;

  // MFA challenge
  'mfa.challengeHeading': string;
  'mfa.submit': string;
  'mfa.useRecoveryCode': string;
  'mfa.useAuthenticationCode': string;
  'mfa.recoverSubmit': string;
  'mfa.resendPrompt': string;
  /** Interpolates {seconds}. Carries the prompt too, so word order stays free. */
  'mfa.resendCountdown': string;
  'mfa.error.invalidCode': string;
  'mfa.error.invalidRecoveryCode': string;
  'mfa.error.resend': string;

  // MFA setup
  'mfaSetup.heading': string;
  'mfaSetup.phoneDescription': string;
  'mfaSetup.sendCode': string;
  'mfaSetup.verifyDescription': string;
  'mfaSetup.verify': string;
  'mfaSetup.changePhone': string;
  'mfaSetup.backupDescription': string;
  'mfaSetup.successHeading': string;
  'mfaSetup.error.sendCode': string;
  'mfaSetup.error.resend': string;
}

export type MessageKey = keyof Messages;

/**
 * English. This is the fallback for everything: an unknown locale, and an
 * unknown key within a known locale, both land here. A raw key must never
 * reach the screen.
 */
export const en: Messages = {
  'field.email': 'Email',
  'field.password': 'Password',
  'field.newPassword': 'New password',
  'field.confirmPassword': 'Confirm password',
  'field.firstName': 'First name',
  'field.lastName': 'Last name',
  'field.phoneNumber': 'Phone number',
  'field.verificationCode': 'Verification code',
  'field.authenticationCode': 'Authentication code',
  'field.recoveryCode': 'Recovery code',
  'placeholder.email': 'you@example.com',
  'placeholder.password': 'Enter your password',
  'placeholder.newPassword': 'At least 8 characters',
  'placeholder.confirmPassword': 'Repeat password',
  'placeholder.firstName': 'First name',
  'placeholder.lastName': 'Last name',
  // TBP-630 — was the US-format `+1 (555) 000-0000`, shown to every European
  // workspace. A format hint that is wrong for most of the audience is worse
  // than none, and the field already has a label.
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Enter 6-digit code',
  'placeholder.recoveryCode': 'Enter recovery code',
  'action.showPassword': 'Show password',
  'action.hidePassword': 'Hide password',
  'action.showPasswords': 'Show passwords',
  'action.hidePasswords': 'Hide passwords',
  'action.backToLogin': 'Back to login',
  'action.backToSignIn': 'Back to sign in',
  'action.resendCode': 'Resend code',
  'action.copy': 'Copy',
  'action.copied': 'Copied!',
  'action.tryAgain': 'Try again',
  'action.done': 'Done',
  'divider.or': 'or',

  'login.heading': 'Log in to your account',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.forgotPassword': 'Forgot password?',
  'login.magicLink': 'Sign in with Magic Link',
  'login.signupPrompt': "Don't have an account?",
  'login.signupLink': 'Sign up',
  'login.error.invalidCredentials': 'Invalid email or password.',

  'forgot.headingRequest': 'Reset your password',
  'forgot.headingSet': 'Set new password',
  'forgot.description': "Enter your email and we'll send you a link to reset your password.",
  'forgot.submit': 'Send reset link',
  'forgot.setSubmit': 'Set a password',
  'forgot.emailSent': 'Check your email for a password reset link.',
  'forgot.successHeading': 'Password set',
  'forgot.error.send': 'Failed to send reset link.',
  'forgot.error.update': 'Failed to update password.',
  'forgot.error.mismatch': 'Passwords do not match.',
  'forgot.error.tooShort': 'Password must be at least 8 characters.',

  'magicLink.heading': 'Sign in with email link',
  'magicLink.description': "Enter your email and we'll send you a sign-in link. No password needed.",
  'magicLink.submit': 'Send magic link',
  'magicLink.sent': 'Check your email — link expires in {expiry}.',
  'magicLink.expiryMinute': '{count} minute',
  'magicLink.expiryMinutes': '{count} minutes',
  'magicLink.expirySeconds': '{count} seconds',
  'magicLink.error.send': 'Failed to send magic link.',
  'magicLink.error.auth': 'Magic link authentication failed.',

  'signup.heading': 'Create your account',
  'signup.submit': 'Sign up',
  'signup.successHeading': 'Check your email',
  'signup.successDescription':
    'We sent a verification link to {email}. Check your inbox to activate your account.',
  'signup.loginPrompt': 'Already have an account?',
  'signup.loginLink': 'Log in',
  'signup.error.create': 'Failed to create account.',

  'passkey.loginButton': 'Sign in with Passkeys',
  'passkey.createHeading': 'Create a passkey',
  'passkey.createPrompt': "Don't have a passkey?",
  'passkey.createLink': 'Create one.',
  'passkey.requestDescription': 'Enter your email and we will send a link to create your passkey.',
  'passkey.requestSubmit': 'Send setup link',
  'passkey.sentHeading': 'Check your email',
  'passkey.sentDescription':
    'We sent a passkey setup link to {email}. Please check your inbox and click the link to create your passkey and finish signing in.',
  'passkey.settingUpHeading': 'Setting up passkey',
  'passkey.setupHeading': 'Passkey setup',
  'passkey.signInNow': 'Sign in now',
  'passkey.requestNewLink': 'Request new setup link',
  'passkey.setupDescription':
    'Follow the prompt from your browser or device to complete passkey setup.',
  'passkey.setupSuccessHeading': 'Passkey created',
  'passkey.setupSuccessDescription': 'Your passkey has been created.',
  'passkey.error.cancelled': 'Passkey setup was cancelled.',
  'passkey.error.authCancelled': 'Passkey authentication was cancelled.',
  'passkey.error.setupFailed': 'Passkey setup failed.',
  'passkey.error.expired': 'This setup link has expired or is invalid.',
  'passkey.error.unsupported': 'Your browser does not support passkeys.',
  'passkey.error.auth': 'Passkey authentication failed.',
  'passkey.error.setup': 'An error occurred during passkey setup.',
  'passkey.error.verify': 'Passkey registration could not be verified.',
  'passkey.error.sendLink': 'Failed to send setup link.',

  'mfa.challengeHeading': 'Two-factor authentication',
  'mfa.submit': 'Verify',
  'mfa.useRecoveryCode': 'Use recovery code',
  'mfa.useAuthenticationCode': 'Use authentication code',
  'mfa.recoverSubmit': 'Recover',
  'mfa.resendPrompt': "Didn't get your text message?",
  'mfa.resendCountdown': "Didn't get your text message? You can resend in {seconds}s.",
  'mfa.error.invalidCode': 'Invalid code. Please try again.',
  'mfa.error.invalidRecoveryCode': 'Invalid recovery code.',
  'mfa.error.resend': 'Failed to resend code.',

  'mfaSetup.heading': 'Set up two-factor authentication',
  'mfaSetup.phoneDescription': 'Enter your phone number to receive a verification code via SMS.',
  'mfaSetup.sendCode': 'Send code',
  'mfaSetup.verifyDescription': 'Enter the 6-digit code sent to your phone.',
  'mfaSetup.verify': 'Verify',
  'mfaSetup.changePhone': 'Change phone number',
  'mfaSetup.backupDescription':
    'Save this recovery code in a safe place. You can use it to access your account if you lose your phone.',
  'mfaSetup.successHeading': 'Two-factor authentication enabled!',
  'mfaSetup.error.sendCode': 'Failed to send verification code.',
  'mfaSetup.error.resend': 'Failed to resend verification code.',
};

/**
 * Swedish. Reviewed-locale status: this and `en` are the two locales shipping
 * in v1 (owner decision 2026-09-11) precisely because they can be checked here.
 * The remaining ten NorthWhistle needs — da, de, es, fi, fr, it, nb, nl, pl, pt
 * — are a data-only follow-up requiring no code change: drop another `Messages`
 * object into `LOCALES` below.
 */
export const sv: Messages = {
  'field.email': 'E-post',
  'field.password': 'Lösenord',
  'field.newPassword': 'Nytt lösenord',
  'field.confirmPassword': 'Bekräfta lösenord',
  'field.firstName': 'Förnamn',
  'field.lastName': 'Efternamn',
  'field.phoneNumber': 'Telefonnummer',
  'field.verificationCode': 'Verifieringskod',
  'field.authenticationCode': 'Autentiseringskod',
  'field.recoveryCode': 'Återställningskod',
  'placeholder.email': 'du@exempel.se',
  'placeholder.password': 'Ange ditt lösenord',
  'placeholder.newPassword': 'Minst 8 tecken',
  'placeholder.confirmPassword': 'Upprepa lösenordet',
  'placeholder.firstName': 'Förnamn',
  'placeholder.lastName': 'Efternamn',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Ange 6-siffrig kod',
  'placeholder.recoveryCode': 'Ange återställningskod',
  'action.showPassword': 'Visa lösenord',
  'action.hidePassword': 'Dölj lösenord',
  'action.showPasswords': 'Visa lösenord',
  'action.hidePasswords': 'Dölj lösenord',
  'action.backToLogin': 'Tillbaka till inloggningen',
  'action.backToSignIn': 'Tillbaka till inloggningen',
  'action.resendCode': 'Skicka koden igen',
  'action.copy': 'Kopiera',
  'action.copied': 'Kopierad!',
  'action.tryAgain': 'Försök igen',
  'action.done': 'Klar',
  'divider.or': 'eller',

  'login.heading': 'Logga in på ditt konto',
  'login.submit': 'Logga in',
  'login.submitting': 'Loggar in…',
  'login.forgotPassword': 'Glömt lösenordet?',
  'login.magicLink': 'Logga in med magisk länk',
  'login.signupPrompt': 'Har du inget konto?',
  'login.signupLink': 'Skapa konto',
  'login.error.invalidCredentials': 'Fel e-postadress eller lösenord.',

  'forgot.headingRequest': 'Återställ ditt lösenord',
  'forgot.headingSet': 'Ange nytt lösenord',
  'forgot.description':
    'Ange din e-postadress så skickar vi en länk för att återställa lösenordet.',
  'forgot.submit': 'Skicka återställningslänk',
  'forgot.setSubmit': 'Ange ett lösenord',
  'forgot.emailSent': 'Kolla din e-post för en länk att återställa lösenordet.',
  'forgot.successHeading': 'Lösenordet är sparat',
  'forgot.error.send': 'Det gick inte att skicka återställningslänken.',
  'forgot.error.update': 'Det gick inte att uppdatera lösenordet.',
  'forgot.error.mismatch': 'Lösenorden stämmer inte överens.',
  'forgot.error.tooShort': 'Lösenordet måste vara minst 8 tecken.',

  'magicLink.heading': 'Logga in med e-postlänk',
  'magicLink.description':
    'Ange din e-postadress så skickar vi en inloggningslänk. Inget lösenord behövs.',
  'magicLink.submit': 'Skicka magisk länk',
  'magicLink.sent': 'Kolla din e-post — länken går ut om {expiry}.',
  'magicLink.expiryMinute': '{count} minut',
  'magicLink.expiryMinutes': '{count} minuter',
  'magicLink.expirySeconds': '{count} sekunder',
  'magicLink.error.send': 'Det gick inte att skicka den magiska länken.',
  'magicLink.error.auth': 'Inloggningen med magisk länk misslyckades.',

  'signup.heading': 'Skapa ditt konto',
  'signup.submit': 'Skapa konto',
  'signup.successHeading': 'Kolla din e-post',
  'signup.successDescription':
    'Vi har skickat en verifieringslänk till {email}. Kolla inkorgen för att aktivera ditt konto.',
  'signup.loginPrompt': 'Har du redan ett konto?',
  'signup.loginLink': 'Logga in',
  'signup.error.create': 'Det gick inte att skapa kontot.',

  'passkey.loginButton': 'Logga in med passkey',
  'passkey.createHeading': 'Skapa en passkey',
  'passkey.createPrompt': 'Har du ingen passkey än?',
  'passkey.createLink': 'Skapa en.',
  'passkey.requestDescription':
    'Ange din e-postadress så skickar vi en länk för att skapa din passkey.',
  'passkey.requestSubmit': 'Skicka länk',
  'passkey.sentHeading': 'Kolla din e-post',
  'passkey.sentDescription':
    'Vi har skickat en länk till {email} för att skapa din passkey. Kolla inkorgen och klicka på länken för att skapa din passkey och slutföra inloggningen.',
  'passkey.settingUpHeading': 'Skapar din passkey',
  'passkey.setupHeading': 'Skapa passkey',
  'passkey.signInNow': 'Logga in nu',
  'passkey.requestNewLink': 'Begär en ny länk',
  'passkey.setupDescription':
    'Följ anvisningarna från din webbläsare eller enhet för att slutföra skapandet av din passkey.',
  'passkey.setupSuccessHeading': 'Passkey skapad',
  'passkey.setupSuccessDescription': 'Din passkey har skapats.',
  'passkey.error.cancelled': 'Skapandet av passkey avbröts.',
  'passkey.error.authCancelled': 'Inloggningen med passkey avbröts.',
  'passkey.error.setupFailed': 'Det gick inte att skapa din passkey.',
  'passkey.error.expired': 'Länken har upphört att gälla eller är ogiltig.',
  'passkey.error.unsupported': 'Din webbläsare har inte stöd för passkeys.',
  'passkey.error.auth': 'Inloggningen med passkey misslyckades.',
  'passkey.error.setup': 'Ett fel uppstod när din passkey skulle skapas.',
  'passkey.error.verify': 'Din passkey kunde inte verifieras.',
  'passkey.error.sendLink': 'Det gick inte att skicka länken.',

  'mfa.challengeHeading': 'Tvåfaktorsautentisering',
  'mfa.submit': 'Verifiera',
  'mfa.useRecoveryCode': 'Använd återställningskod',
  'mfa.useAuthenticationCode': 'Använd autentiseringskod',
  'mfa.recoverSubmit': 'Återställ',
  'mfa.resendPrompt': 'Fick du inget SMS?',
  'mfa.resendCountdown': 'Fick du inget SMS? Du kan skicka igen om {seconds} s.',
  'mfa.error.invalidCode': 'Ogiltig kod. Försök igen.',
  'mfa.error.invalidRecoveryCode': 'Ogiltig återställningskod.',
  'mfa.error.resend': 'Det gick inte att skicka koden igen.',

  'mfaSetup.heading': 'Aktivera tvåfaktorsautentisering',
  'mfaSetup.phoneDescription':
    'Ange ditt telefonnummer för att få en verifieringskod via SMS.',
  'mfaSetup.sendCode': 'Skicka kod',
  'mfaSetup.verifyDescription': 'Ange den 6-siffriga koden som skickades till din telefon.',
  'mfaSetup.verify': 'Verifiera',
  'mfaSetup.changePhone': 'Byt telefonnummer',
  'mfaSetup.backupDescription':
    'Spara den här återställningskoden på ett säkert ställe. Du kan använda den för att komma åt ditt konto om du förlorar din telefon.',
  'mfaSetup.successHeading': 'Tvåfaktorsautentisering aktiverad!',
  'mfaSetup.error.sendCode': 'Det gick inte att skicka verifieringskoden.',
  'mfaSetup.error.resend': 'Det gick inte att skicka verifieringskoden igen.',
};

/** Locales shipping with the package. Adding one is data-only. */
export const LOCALES: Record<string, Messages> = { en, sv };
