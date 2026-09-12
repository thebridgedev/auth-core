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
  /**
   * Description for a setup screen that waits for the user to click before it
   * starts the browser ceremony (TBP-633). Distinct from
   * `passkey.setupDescription`, which describes a ceremony ALREADY in flight —
   * telling somebody to "follow the prompt from your browser" when no prompt
   * has been raised yet is instructions for a thing that is not happening.
   */
  'passkey.setupClickPrompt': string;
  /** Button that starts the ceremony on a click-to-start setup screen. */
  'passkey.setupSubmit': string;
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

  // Tenant / workspace selection (TBP-634)
  /**
   * Heading on the workspace picker that renders MID-LOGIN, between
   * authenticating and landing, for a user who belongs to several tenants.
   * Untranslated it put one English screen in the middle of an otherwise
   * translated flow — more jarring than a consistently English login.
   */
  'tenant.chooseHeading': string;
  'tenant.error.select': string;
  'workspace.error.load': string;
  'workspace.error.switch': string;

  // SSO (TBP-634)
  /** Default label on a federation button. Interpolates {provider}. */
  'sso.continueWith': string;
  'sso.error.popupBlocked': string;
  'sso.error.login': string;
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
  'passkey.setupClickPrompt':
    'Create a passkey on this device and sign in without a password from now on.',
  'passkey.setupSubmit': 'Create passkey',
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

  'tenant.chooseHeading': 'Choose a workspace',
  'tenant.error.select': 'Failed to select workspace.',
  'workspace.error.load': 'Failed to load workspaces.',
  'workspace.error.switch': 'Failed to switch workspace.',

  'sso.continueWith': 'Continue with {provider}',
  'sso.error.popupBlocked': 'Pop-up was blocked. Please allow pop-ups and try again.',
  'sso.error.login': 'SSO login failed',
};

/**
 * Swedish.
 *
 * ## Register and house style, applied to every locale below
 *
 * These were the two hand-checked locales; the ten added in TBP-632 follow the
 * conventions this one set, so read it as the reference before adding an
 * eleventh.
 *
 * - **Informal address** wherever the language distinguishes it — `du`, `tu`,
 *   `jij`, `ty`. This is a product login, not a bank letter.
 * - **Errors are impersonal.** "The code could not be sent", not "we failed to
 *   send". The user did not do anything wrong and does not care who did.
 * - **Errors end in a full stop; labels and buttons do not.**
 * - **`placeholder.phoneNumber` stays empty in every locale.** A format hint
 *   that is wrong for the reader is worse than none (TBP-630).
 * - **Placeholders are positioned, not concatenated.** `{email}`, `{expiry}`,
 *   `{count}`, `{seconds}` and `{provider}` sit where the sentence wants them.
 * - **"passkey" is left untranslated** — it is the term the browser and OS
 *   themselves show the user, and inventing a local word for it would leave the
 *   sentence describing something the system never calls by that name.
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
  'passkey.setupClickPrompt':
    'Skapa en passkey på den här enheten och logga in utan lösenord i fortsättningen.',
  'passkey.setupSubmit': 'Skapa passkey',
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

  'tenant.chooseHeading': 'Välj arbetsyta',
  'tenant.error.select': 'Det gick inte att välja arbetsyta.',
  'workspace.error.load': 'Det gick inte att hämta dina arbetsytor.',
  'workspace.error.switch': 'Det gick inte att byta arbetsyta.',

  'sso.continueWith': 'Fortsätt med {provider}',
  'sso.error.popupBlocked': 'Popup-fönstret blockerades. Tillåt popup-fönster och försök igen.',
  'sso.error.login': 'Inloggningen misslyckades.',
};

/** Danish. Informal `du`. */
export const da: Messages = {
  'field.email': 'E-mail',
  'field.password': 'Adgangskode',
  'field.newPassword': 'Ny adgangskode',
  'field.confirmPassword': 'Bekræft adgangskode',
  'field.firstName': 'Fornavn',
  'field.lastName': 'Efternavn',
  'field.phoneNumber': 'Telefonnummer',
  'field.verificationCode': 'Bekræftelseskode',
  'field.authenticationCode': 'Godkendelseskode',
  'field.recoveryCode': 'Gendannelseskode',
  'placeholder.email': 'du@eksempel.dk',
  'placeholder.password': 'Indtast din adgangskode',
  'placeholder.newPassword': 'Mindst 8 tegn',
  'placeholder.confirmPassword': 'Gentag adgangskoden',
  'placeholder.firstName': 'Fornavn',
  'placeholder.lastName': 'Efternavn',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Indtast 6-cifret kode',
  'placeholder.recoveryCode': 'Indtast gendannelseskode',
  'action.showPassword': 'Vis adgangskode',
  'action.hidePassword': 'Skjul adgangskode',
  'action.showPasswords': 'Vis adgangskoder',
  'action.hidePasswords': 'Skjul adgangskoder',
  'action.backToLogin': 'Tilbage til login',
  'action.backToSignIn': 'Tilbage til login',
  'action.resendCode': 'Send koden igen',
  'action.copy': 'Kopiér',
  'action.copied': 'Kopieret!',
  'action.tryAgain': 'Prøv igen',
  'action.done': 'Færdig',
  'divider.or': 'eller',

  'login.heading': 'Log ind på din konto',
  'login.submit': 'Log ind',
  'login.submitting': 'Logger ind…',
  'login.forgotPassword': 'Glemt adgangskode?',
  'login.magicLink': 'Log ind med magisk link',
  'login.signupPrompt': 'Har du ikke en konto?',
  'login.signupLink': 'Opret konto',
  'login.error.invalidCredentials': 'Forkert e-mail eller adgangskode.',

  'forgot.headingRequest': 'Nulstil din adgangskode',
  'forgot.headingSet': 'Vælg ny adgangskode',
  'forgot.description':
    'Indtast din e-mail, så sender vi dig et link til at nulstille din adgangskode.',
  'forgot.submit': 'Send nulstillingslink',
  'forgot.setSubmit': 'Vælg en adgangskode',
  'forgot.emailSent': 'Tjek din e-mail for et link til at nulstille adgangskoden.',
  'forgot.successHeading': 'Adgangskoden er gemt',
  'forgot.error.send': 'Nulstillingslinket kunne ikke sendes.',
  'forgot.error.update': 'Adgangskoden kunne ikke opdateres.',
  'forgot.error.mismatch': 'Adgangskoderne er ikke ens.',
  'forgot.error.tooShort': 'Adgangskoden skal være på mindst 8 tegn.',

  'magicLink.heading': 'Log ind med e-mail-link',
  'magicLink.description':
    'Indtast din e-mail, så sender vi dig et login-link. Ingen adgangskode nødvendig.',
  'magicLink.submit': 'Send magisk link',
  'magicLink.sent': 'Tjek din e-mail — linket udløber om {expiry}.',
  'magicLink.expiryMinute': '{count} minut',
  'magicLink.expiryMinutes': '{count} minutter',
  'magicLink.expirySeconds': '{count} sekunder',
  'magicLink.error.send': 'Det magiske link kunne ikke sendes.',
  'magicLink.error.auth': 'Login med magisk link mislykkedes.',

  'signup.heading': 'Opret din konto',
  'signup.submit': 'Opret konto',
  'signup.successHeading': 'Tjek din e-mail',
  'signup.successDescription':
    'Vi har sendt et bekræftelseslink til {email}. Tjek din indbakke for at aktivere din konto.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Log ind',
  'signup.error.create': 'Kontoen kunne ikke oprettes.',

  'passkey.loginButton': 'Log ind med passkey',
  'passkey.createHeading': 'Opret en passkey',
  'passkey.createPrompt': 'Har du ingen passkey?',
  'passkey.createLink': 'Opret en.',
  'passkey.requestDescription':
    'Indtast din e-mail, så sender vi et link til at oprette din passkey.',
  'passkey.requestSubmit': 'Send link',
  'passkey.sentHeading': 'Tjek din e-mail',
  'passkey.sentDescription':
    'Vi har sendt et link til {email}, så du kan oprette din passkey. Tjek din indbakke og klik på linket for at oprette din passkey og fuldføre dit login.',
  'passkey.settingUpHeading': 'Opretter din passkey',
  'passkey.setupHeading': 'Opret passkey',
  'passkey.signInNow': 'Log ind nu',
  'passkey.requestNewLink': 'Bed om et nyt link',
  'passkey.setupDescription':
    'Følg anvisningerne fra din browser eller enhed for at fuldføre oprettelsen af din passkey.',
  'passkey.setupClickPrompt':
    'Opret en passkey på denne enhed, og log ind uden adgangskode fremover.',
  'passkey.setupSubmit': 'Opret passkey',
  'passkey.setupSuccessHeading': 'Passkey oprettet',
  'passkey.setupSuccessDescription': 'Din passkey er oprettet.',
  'passkey.error.cancelled': 'Oprettelsen af din passkey blev afbrudt.',
  'passkey.error.authCancelled': 'Login med passkey blev afbrudt.',
  'passkey.error.setupFailed': 'Din passkey kunne ikke oprettes.',
  'passkey.error.expired': 'Linket er udløbet eller ugyldigt.',
  'passkey.error.unsupported': 'Din browser understøtter ikke passkeys.',
  'passkey.error.auth': 'Login med passkey mislykkedes.',
  'passkey.error.setup': 'Der opstod en fejl under oprettelsen af din passkey.',
  'passkey.error.verify': 'Din passkey kunne ikke bekræftes.',
  'passkey.error.sendLink': 'Linket kunne ikke sendes.',

  'mfa.challengeHeading': 'Tofaktorgodkendelse',
  'mfa.submit': 'Bekræft',
  'mfa.useRecoveryCode': 'Brug gendannelseskode',
  'mfa.useAuthenticationCode': 'Brug godkendelseskode',
  'mfa.recoverSubmit': 'Gendan',
  'mfa.resendPrompt': 'Fik du ingen sms?',
  'mfa.resendCountdown': 'Fik du ingen sms? Du kan sende igen om {seconds} s.',
  'mfa.error.invalidCode': 'Ugyldig kode. Prøv igen.',
  'mfa.error.invalidRecoveryCode': 'Ugyldig gendannelseskode.',
  'mfa.error.resend': 'Koden kunne ikke sendes igen.',

  'mfaSetup.heading': 'Slå tofaktorgodkendelse til',
  'mfaSetup.phoneDescription':
    'Indtast dit telefonnummer for at modtage en bekræftelseskode via sms.',
  'mfaSetup.sendCode': 'Send kode',
  'mfaSetup.verifyDescription': 'Indtast den 6-cifrede kode, der blev sendt til din telefon.',
  'mfaSetup.verify': 'Bekræft',
  'mfaSetup.changePhone': 'Skift telefonnummer',
  'mfaSetup.backupDescription':
    'Gem denne gendannelseskode et sikkert sted. Du kan bruge den til at få adgang til din konto, hvis du mister din telefon.',
  'mfaSetup.successHeading': 'Tofaktorgodkendelse er slået til!',
  'mfaSetup.error.sendCode': 'Bekræftelseskoden kunne ikke sendes.',
  'mfaSetup.error.resend': 'Bekræftelseskoden kunne ikke sendes igen.',

  'tenant.chooseHeading': 'Vælg et arbejdsområde',
  'tenant.error.select': 'Arbejdsområdet kunne ikke vælges.',
  'workspace.error.load': 'Dine arbejdsområder kunne ikke hentes.',
  'workspace.error.switch': 'Der kunne ikke skiftes arbejdsområde.',

  'sso.continueWith': 'Fortsæt med {provider}',
  'sso.error.popupBlocked': 'Pop op-vinduet blev blokeret. Tillad pop op-vinduer, og prøv igen.',
  'sso.error.login': 'Login mislykkedes.',
};

/** Norwegian Bokmål. Informal `du`. */
export const nb: Messages = {
  'field.email': 'E-post',
  'field.password': 'Passord',
  'field.newPassword': 'Nytt passord',
  'field.confirmPassword': 'Bekreft passord',
  'field.firstName': 'Fornavn',
  'field.lastName': 'Etternavn',
  'field.phoneNumber': 'Telefonnummer',
  'field.verificationCode': 'Bekreftelseskode',
  'field.authenticationCode': 'Autentiseringskode',
  'field.recoveryCode': 'Gjenopprettingskode',
  'placeholder.email': 'du@eksempel.no',
  'placeholder.password': 'Skriv inn passordet ditt',
  'placeholder.newPassword': 'Minst 8 tegn',
  'placeholder.confirmPassword': 'Gjenta passordet',
  'placeholder.firstName': 'Fornavn',
  'placeholder.lastName': 'Etternavn',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Skriv inn 6-sifret kode',
  'placeholder.recoveryCode': 'Skriv inn gjenopprettingskode',
  'action.showPassword': 'Vis passord',
  'action.hidePassword': 'Skjul passord',
  'action.showPasswords': 'Vis passord',
  'action.hidePasswords': 'Skjul passord',
  'action.backToLogin': 'Tilbake til innlogging',
  'action.backToSignIn': 'Tilbake til innlogging',
  'action.resendCode': 'Send koden på nytt',
  'action.copy': 'Kopier',
  'action.copied': 'Kopiert!',
  'action.tryAgain': 'Prøv igjen',
  'action.done': 'Ferdig',
  'divider.or': 'eller',

  'login.heading': 'Logg inn på kontoen din',
  'login.submit': 'Logg inn',
  'login.submitting': 'Logger inn…',
  'login.forgotPassword': 'Glemt passord?',
  'login.magicLink': 'Logg inn med magisk lenke',
  'login.signupPrompt': 'Har du ingen konto?',
  'login.signupLink': 'Opprett konto',
  'login.error.invalidCredentials': 'Feil e-postadresse eller passord.',

  'forgot.headingRequest': 'Tilbakestill passordet ditt',
  'forgot.headingSet': 'Velg nytt passord',
  'forgot.description':
    'Skriv inn e-postadressen din, så sender vi deg en lenke for å tilbakestille passordet.',
  'forgot.submit': 'Send lenke',
  'forgot.setSubmit': 'Velg et passord',
  'forgot.emailSent': 'Sjekk e-posten din for en lenke til å tilbakestille passordet.',
  'forgot.successHeading': 'Passordet er lagret',
  'forgot.error.send': 'Lenken kunne ikke sendes.',
  'forgot.error.update': 'Passordet kunne ikke oppdateres.',
  'forgot.error.mismatch': 'Passordene er ikke like.',
  'forgot.error.tooShort': 'Passordet må være på minst 8 tegn.',

  'magicLink.heading': 'Logg inn med e-postlenke',
  'magicLink.description':
    'Skriv inn e-postadressen din, så sender vi deg en innloggingslenke. Ingen passord nødvendig.',
  'magicLink.submit': 'Send magisk lenke',
  'magicLink.sent': 'Sjekk e-posten din — lenken utløper om {expiry}.',
  'magicLink.expiryMinute': '{count} minutt',
  'magicLink.expiryMinutes': '{count} minutter',
  'magicLink.expirySeconds': '{count} sekunder',
  'magicLink.error.send': 'Den magiske lenken kunne ikke sendes.',
  'magicLink.error.auth': 'Innlogging med magisk lenke mislyktes.',

  'signup.heading': 'Opprett kontoen din',
  'signup.submit': 'Opprett konto',
  'signup.successHeading': 'Sjekk e-posten din',
  'signup.successDescription':
    'Vi har sendt en bekreftelseslenke til {email}. Sjekk innboksen for å aktivere kontoen din.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Logg inn',
  'signup.error.create': 'Kontoen kunne ikke opprettes.',

  'passkey.loginButton': 'Logg inn med passkey',
  'passkey.createHeading': 'Opprett en passkey',
  'passkey.createPrompt': 'Har du ingen passkey?',
  'passkey.createLink': 'Opprett en.',
  'passkey.requestDescription':
    'Skriv inn e-postadressen din, så sender vi en lenke for å opprette din passkey.',
  'passkey.requestSubmit': 'Send lenke',
  'passkey.sentHeading': 'Sjekk e-posten din',
  'passkey.sentDescription':
    'Vi har sendt en lenke til {email} for å opprette din passkey. Sjekk innboksen og klikk på lenken for å opprette din passkey og fullføre innloggingen.',
  'passkey.settingUpHeading': 'Oppretter din passkey',
  'passkey.setupHeading': 'Opprett passkey',
  'passkey.signInNow': 'Logg inn nå',
  'passkey.requestNewLink': 'Be om en ny lenke',
  'passkey.setupDescription':
    'Følg anvisningene fra nettleseren eller enheten din for å fullføre opprettelsen av din passkey.',
  'passkey.setupClickPrompt':
    'Opprett en passkey på denne enheten, og logg inn uten passord fra nå av.',
  'passkey.setupSubmit': 'Opprett passkey',
  'passkey.setupSuccessHeading': 'Passkey opprettet',
  'passkey.setupSuccessDescription': 'Din passkey er opprettet.',
  'passkey.error.cancelled': 'Opprettelsen av din passkey ble avbrutt.',
  'passkey.error.authCancelled': 'Innlogging med passkey ble avbrutt.',
  'passkey.error.setupFailed': 'Din passkey kunne ikke opprettes.',
  'passkey.error.expired': 'Lenken har utløpt eller er ugyldig.',
  'passkey.error.unsupported': 'Nettleseren din støtter ikke passkeys.',
  'passkey.error.auth': 'Innlogging med passkey mislyktes.',
  'passkey.error.setup': 'Det oppsto en feil da din passkey skulle opprettes.',
  'passkey.error.verify': 'Din passkey kunne ikke bekreftes.',
  'passkey.error.sendLink': 'Lenken kunne ikke sendes.',

  'mfa.challengeHeading': 'Tofaktorautentisering',
  'mfa.submit': 'Bekreft',
  'mfa.useRecoveryCode': 'Bruk gjenopprettingskode',
  'mfa.useAuthenticationCode': 'Bruk autentiseringskode',
  'mfa.recoverSubmit': 'Gjenopprett',
  'mfa.resendPrompt': 'Fikk du ingen SMS?',
  'mfa.resendCountdown': 'Fikk du ingen SMS? Du kan sende på nytt om {seconds} s.',
  'mfa.error.invalidCode': 'Ugyldig kode. Prøv igjen.',
  'mfa.error.invalidRecoveryCode': 'Ugyldig gjenopprettingskode.',
  'mfa.error.resend': 'Koden kunne ikke sendes på nytt.',

  'mfaSetup.heading': 'Slå på tofaktorautentisering',
  'mfaSetup.phoneDescription':
    'Skriv inn telefonnummeret ditt for å få en bekreftelseskode på SMS.',
  'mfaSetup.sendCode': 'Send kode',
  'mfaSetup.verifyDescription': 'Skriv inn den 6-sifrede koden som ble sendt til telefonen din.',
  'mfaSetup.verify': 'Bekreft',
  'mfaSetup.changePhone': 'Bytt telefonnummer',
  'mfaSetup.backupDescription':
    'Lagre denne gjenopprettingskoden på et trygt sted. Du kan bruke den til å få tilgang til kontoen din hvis du mister telefonen.',
  'mfaSetup.successHeading': 'Tofaktorautentisering er slått på!',
  'mfaSetup.error.sendCode': 'Bekreftelseskoden kunne ikke sendes.',
  'mfaSetup.error.resend': 'Bekreftelseskoden kunne ikke sendes på nytt.',

  'tenant.chooseHeading': 'Velg et arbeidsområde',
  'tenant.error.select': 'Arbeidsområdet kunne ikke velges.',
  'workspace.error.load': 'Arbeidsområdene dine kunne ikke hentes.',
  'workspace.error.switch': 'Kunne ikke bytte arbeidsområde.',

  'sso.continueWith': 'Fortsett med {provider}',
  'sso.error.popupBlocked':
    'Popup-vinduet ble blokkert. Tillat popup-vinduer, og prøv igjen.',
  'sso.error.login': 'Innloggingen mislyktes.',
};

/** Dutch. Informal `je`/`jij`. */
export const nl: Messages = {
  'field.email': 'E-mailadres',
  'field.password': 'Wachtwoord',
  'field.newPassword': 'Nieuw wachtwoord',
  'field.confirmPassword': 'Bevestig wachtwoord',
  'field.firstName': 'Voornaam',
  'field.lastName': 'Achternaam',
  'field.phoneNumber': 'Telefoonnummer',
  'field.verificationCode': 'Verificatiecode',
  'field.authenticationCode': 'Authenticatiecode',
  'field.recoveryCode': 'Herstelcode',
  'placeholder.email': 'jij@voorbeeld.nl',
  'placeholder.password': 'Voer je wachtwoord in',
  'placeholder.newPassword': 'Minimaal 8 tekens',
  'placeholder.confirmPassword': 'Herhaal het wachtwoord',
  'placeholder.firstName': 'Voornaam',
  'placeholder.lastName': 'Achternaam',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Voer de 6-cijferige code in',
  'placeholder.recoveryCode': 'Voer je herstelcode in',
  'action.showPassword': 'Wachtwoord tonen',
  'action.hidePassword': 'Wachtwoord verbergen',
  'action.showPasswords': 'Wachtwoorden tonen',
  'action.hidePasswords': 'Wachtwoorden verbergen',
  'action.backToLogin': 'Terug naar inloggen',
  'action.backToSignIn': 'Terug naar inloggen',
  'action.resendCode': 'Code opnieuw versturen',
  'action.copy': 'Kopiëren',
  'action.copied': 'Gekopieerd!',
  'action.tryAgain': 'Opnieuw proberen',
  'action.done': 'Klaar',
  'divider.or': 'of',

  'login.heading': 'Log in op je account',
  'login.submit': 'Inloggen',
  'login.submitting': 'Bezig met inloggen…',
  'login.forgotPassword': 'Wachtwoord vergeten?',
  'login.magicLink': 'Inloggen met magic link',
  'login.signupPrompt': 'Nog geen account?',
  'login.signupLink': 'Account aanmaken',
  'login.error.invalidCredentials': 'Onjuist e-mailadres of wachtwoord.',

  'forgot.headingRequest': 'Stel je wachtwoord opnieuw in',
  'forgot.headingSet': 'Nieuw wachtwoord instellen',
  'forgot.description':
    'Voer je e-mailadres in, dan sturen we je een link om je wachtwoord opnieuw in te stellen.',
  'forgot.submit': 'Link versturen',
  'forgot.setSubmit': 'Wachtwoord instellen',
  'forgot.emailSent': 'Check je e-mail voor een link om je wachtwoord opnieuw in te stellen.',
  'forgot.successHeading': 'Wachtwoord opgeslagen',
  'forgot.error.send': 'De link kon niet worden verstuurd.',
  'forgot.error.update': 'Het wachtwoord kon niet worden bijgewerkt.',
  'forgot.error.mismatch': 'De wachtwoorden komen niet overeen.',
  'forgot.error.tooShort': 'Het wachtwoord moet minimaal 8 tekens lang zijn.',

  'magicLink.heading': 'Inloggen met een e-maillink',
  'magicLink.description':
    'Voer je e-mailadres in, dan sturen we je een inloglink. Geen wachtwoord nodig.',
  'magicLink.submit': 'Magic link versturen',
  'magicLink.sent': 'Check je e-mail — de link verloopt over {expiry}.',
  'magicLink.expiryMinute': '{count} minuut',
  'magicLink.expiryMinutes': '{count} minuten',
  'magicLink.expirySeconds': '{count} seconden',
  'magicLink.error.send': 'De magic link kon niet worden verstuurd.',
  'magicLink.error.auth': 'Inloggen met de magic link is mislukt.',

  'signup.heading': 'Maak je account aan',
  'signup.submit': 'Account aanmaken',
  'signup.successHeading': 'Check je e-mail',
  'signup.successDescription':
    'We hebben een verificatielink naar {email} gestuurd. Check je inbox om je account te activeren.',
  'signup.loginPrompt': 'Heb je al een account?',
  'signup.loginLink': 'Inloggen',
  'signup.error.create': 'Het account kon niet worden aangemaakt.',

  'passkey.loginButton': 'Inloggen met passkey',
  'passkey.createHeading': 'Een passkey aanmaken',
  'passkey.createPrompt': 'Heb je nog geen passkey?',
  'passkey.createLink': 'Maak er een aan.',
  'passkey.requestDescription':
    'Voer je e-mailadres in, dan sturen we je een link om je passkey aan te maken.',
  'passkey.requestSubmit': 'Link versturen',
  'passkey.sentHeading': 'Check je e-mail',
  'passkey.sentDescription':
    'We hebben een link naar {email} gestuurd om je passkey aan te maken. Check je inbox en klik op de link om je passkey aan te maken en het inloggen af te ronden.',
  'passkey.settingUpHeading': 'Bezig met aanmaken',
  'passkey.setupHeading': 'Passkey aanmaken',
  'passkey.signInNow': 'Nu inloggen',
  'passkey.requestNewLink': 'Nieuwe link aanvragen',
  'passkey.setupDescription':
    'Volg de aanwijzingen van je browser of apparaat om het aanmaken van je passkey af te ronden.',
  'passkey.setupClickPrompt':
    'Maak een passkey aan op dit apparaat en log voortaan in zonder wachtwoord.',
  'passkey.setupSubmit': 'Passkey aanmaken',
  'passkey.setupSuccessHeading': 'Passkey aangemaakt',
  'passkey.setupSuccessDescription': 'Je passkey is aangemaakt.',
  'passkey.error.cancelled': 'Het aanmaken van je passkey is geannuleerd.',
  'passkey.error.authCancelled': 'Inloggen met je passkey is geannuleerd.',
  'passkey.error.setupFailed': 'Je passkey kon niet worden aangemaakt.',
  'passkey.error.expired': 'Deze link is verlopen of ongeldig.',
  'passkey.error.unsupported': 'Je browser ondersteunt geen passkeys.',
  'passkey.error.auth': 'Inloggen met je passkey is mislukt.',
  'passkey.error.setup': 'Er is iets misgegaan bij het aanmaken van je passkey.',
  'passkey.error.verify': 'Je passkey kon niet worden geverifieerd.',
  'passkey.error.sendLink': 'De link kon niet worden verstuurd.',

  'mfa.challengeHeading': 'Tweestapsverificatie',
  'mfa.submit': 'Verifiëren',
  'mfa.useRecoveryCode': 'Herstelcode gebruiken',
  'mfa.useAuthenticationCode': 'Authenticatiecode gebruiken',
  'mfa.recoverSubmit': 'Herstellen',
  'mfa.resendPrompt': 'Geen sms ontvangen?',
  'mfa.resendCountdown': 'Geen sms ontvangen? Je kunt over {seconds} s opnieuw versturen.',
  'mfa.error.invalidCode': 'Ongeldige code. Probeer het opnieuw.',
  'mfa.error.invalidRecoveryCode': 'Ongeldige herstelcode.',
  'mfa.error.resend': 'De code kon niet opnieuw worden verstuurd.',

  'mfaSetup.heading': 'Tweestapsverificatie instellen',
  'mfaSetup.phoneDescription':
    'Voer je telefoonnummer in om een verificatiecode via sms te ontvangen.',
  'mfaSetup.sendCode': 'Code versturen',
  'mfaSetup.verifyDescription': 'Voer de 6-cijferige code in die naar je telefoon is gestuurd.',
  'mfaSetup.verify': 'Verifiëren',
  'mfaSetup.changePhone': 'Telefoonnummer wijzigen',
  'mfaSetup.backupDescription':
    'Bewaar deze herstelcode op een veilige plek. Je kunt hem gebruiken om bij je account te komen als je je telefoon kwijtraakt.',
  'mfaSetup.successHeading': 'Tweestapsverificatie is ingeschakeld!',
  'mfaSetup.error.sendCode': 'De verificatiecode kon niet worden verstuurd.',
  'mfaSetup.error.resend': 'De verificatiecode kon niet opnieuw worden verstuurd.',

  'tenant.chooseHeading': 'Kies een workspace',
  'tenant.error.select': 'De workspace kon niet worden geselecteerd.',
  'workspace.error.load': 'Je workspaces konden niet worden geladen.',
  'workspace.error.switch': 'Wisselen van workspace is niet gelukt.',

  'sso.continueWith': 'Doorgaan met {provider}',
  'sso.error.popupBlocked':
    'De pop-up is geblokkeerd. Sta pop-ups toe en probeer het opnieuw.',
  'sso.error.login': 'Inloggen is mislukt.',
};

/** German. Informal `du`. */
export const de: Messages = {
  'field.email': 'E-Mail',
  'field.password': 'Passwort',
  'field.newPassword': 'Neues Passwort',
  'field.confirmPassword': 'Passwort bestätigen',
  'field.firstName': 'Vorname',
  'field.lastName': 'Nachname',
  'field.phoneNumber': 'Telefonnummer',
  'field.verificationCode': 'Bestätigungscode',
  'field.authenticationCode': 'Authentifizierungscode',
  'field.recoveryCode': 'Wiederherstellungscode',
  'placeholder.email': 'du@beispiel.de',
  'placeholder.password': 'Passwort eingeben',
  'placeholder.newPassword': 'Mindestens 8 Zeichen',
  'placeholder.confirmPassword': 'Passwort wiederholen',
  'placeholder.firstName': 'Vorname',
  'placeholder.lastName': 'Nachname',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': '6-stelligen Code eingeben',
  'placeholder.recoveryCode': 'Wiederherstellungscode eingeben',
  'action.showPassword': 'Passwort anzeigen',
  'action.hidePassword': 'Passwort verbergen',
  'action.showPasswords': 'Passwörter anzeigen',
  'action.hidePasswords': 'Passwörter verbergen',
  'action.backToLogin': 'Zurück zur Anmeldung',
  'action.backToSignIn': 'Zurück zur Anmeldung',
  'action.resendCode': 'Code erneut senden',
  'action.copy': 'Kopieren',
  'action.copied': 'Kopiert!',
  'action.tryAgain': 'Erneut versuchen',
  'action.done': 'Fertig',
  'divider.or': 'oder',

  'login.heading': 'Bei deinem Konto anmelden',
  'login.submit': 'Anmelden',
  'login.submitting': 'Anmeldung läuft…',
  'login.forgotPassword': 'Passwort vergessen?',
  'login.magicLink': 'Mit Magic Link anmelden',
  'login.signupPrompt': 'Noch kein Konto?',
  'login.signupLink': 'Konto erstellen',
  'login.error.invalidCredentials': 'E-Mail-Adresse oder Passwort ist falsch.',

  'forgot.headingRequest': 'Passwort zurücksetzen',
  'forgot.headingSet': 'Neues Passwort festlegen',
  'forgot.description':
    'Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Link zum Zurücksetzen deines Passworts.',
  'forgot.submit': 'Link senden',
  'forgot.setSubmit': 'Passwort festlegen',
  'forgot.emailSent': 'Sieh in deinem Postfach nach dem Link zum Zurücksetzen des Passworts.',
  'forgot.successHeading': 'Passwort gespeichert',
  'forgot.error.send': 'Der Link konnte nicht gesendet werden.',
  'forgot.error.update': 'Das Passwort konnte nicht aktualisiert werden.',
  'forgot.error.mismatch': 'Die Passwörter stimmen nicht überein.',
  'forgot.error.tooShort': 'Das Passwort muss mindestens 8 Zeichen lang sein.',

  'magicLink.heading': 'Mit E-Mail-Link anmelden',
  'magicLink.description':
    'Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Anmeldelink. Kein Passwort nötig.',
  'magicLink.submit': 'Magic Link senden',
  'magicLink.sent': 'Sieh in deinem Postfach nach — der Link läuft in {expiry} ab.',
  'magicLink.expiryMinute': '{count} Minute',
  'magicLink.expiryMinutes': '{count} Minuten',
  'magicLink.expirySeconds': '{count} Sekunden',
  'magicLink.error.send': 'Der Magic Link konnte nicht gesendet werden.',
  'magicLink.error.auth': 'Die Anmeldung mit dem Magic Link ist fehlgeschlagen.',

  'signup.heading': 'Konto erstellen',
  'signup.submit': 'Konto erstellen',
  'signup.successHeading': 'Sieh in deinem Postfach nach',
  'signup.successDescription':
    'Wir haben einen Bestätigungslink an {email} geschickt. Sieh in deinem Postfach nach, um dein Konto zu aktivieren.',
  'signup.loginPrompt': 'Du hast schon ein Konto?',
  'signup.loginLink': 'Anmelden',
  'signup.error.create': 'Das Konto konnte nicht erstellt werden.',

  'passkey.loginButton': 'Mit Passkey anmelden',
  'passkey.createHeading': 'Passkey erstellen',
  'passkey.createPrompt': 'Noch keinen Passkey?',
  'passkey.createLink': 'Jetzt erstellen.',
  'passkey.requestDescription':
    'Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Link zum Erstellen deines Passkeys.',
  'passkey.requestSubmit': 'Link senden',
  'passkey.sentHeading': 'Sieh in deinem Postfach nach',
  'passkey.sentDescription':
    'Wir haben einen Link zum Erstellen deines Passkeys an {email} geschickt. Sieh in deinem Postfach nach und klicke auf den Link, um deinen Passkey zu erstellen und die Anmeldung abzuschließen.',
  'passkey.settingUpHeading': 'Passkey wird erstellt',
  'passkey.setupHeading': 'Passkey erstellen',
  'passkey.signInNow': 'Jetzt anmelden',
  'passkey.requestNewLink': 'Neuen Link anfordern',
  'passkey.setupDescription':
    'Folge den Anweisungen deines Browsers oder Geräts, um deinen Passkey fertig einzurichten.',
  'passkey.setupClickPrompt':
    'Erstelle auf diesem Gerät einen Passkey und melde dich künftig ohne Passwort an.',
  'passkey.setupSubmit': 'Passkey erstellen',
  'passkey.setupSuccessHeading': 'Passkey erstellt',
  'passkey.setupSuccessDescription': 'Dein Passkey wurde erstellt.',
  'passkey.error.cancelled': 'Das Erstellen des Passkeys wurde abgebrochen.',
  'passkey.error.authCancelled': 'Die Anmeldung mit dem Passkey wurde abgebrochen.',
  'passkey.error.setupFailed': 'Dein Passkey konnte nicht erstellt werden.',
  'passkey.error.expired': 'Dieser Link ist abgelaufen oder ungültig.',
  'passkey.error.unsupported': 'Dein Browser unterstützt keine Passkeys.',
  'passkey.error.auth': 'Die Anmeldung mit dem Passkey ist fehlgeschlagen.',
  'passkey.error.setup': 'Beim Erstellen deines Passkeys ist ein Fehler aufgetreten.',
  'passkey.error.verify': 'Dein Passkey konnte nicht bestätigt werden.',
  'passkey.error.sendLink': 'Der Link konnte nicht gesendet werden.',

  'mfa.challengeHeading': 'Zwei-Faktor-Authentifizierung',
  'mfa.submit': 'Bestätigen',
  'mfa.useRecoveryCode': 'Wiederherstellungscode verwenden',
  'mfa.useAuthenticationCode': 'Authentifizierungscode verwenden',
  'mfa.recoverSubmit': 'Wiederherstellen',
  'mfa.resendPrompt': 'Keine SMS erhalten?',
  'mfa.resendCountdown': 'Keine SMS erhalten? Du kannst in {seconds} s erneut senden.',
  'mfa.error.invalidCode': 'Ungültiger Code. Versuche es erneut.',
  'mfa.error.invalidRecoveryCode': 'Ungültiger Wiederherstellungscode.',
  'mfa.error.resend': 'Der Code konnte nicht erneut gesendet werden.',

  'mfaSetup.heading': 'Zwei-Faktor-Authentifizierung einrichten',
  'mfaSetup.phoneDescription':
    'Gib deine Telefonnummer ein, um einen Bestätigungscode per SMS zu erhalten.',
  'mfaSetup.sendCode': 'Code senden',
  'mfaSetup.verifyDescription': 'Gib den 6-stelligen Code ein, den wir an dein Telefon geschickt haben.',
  'mfaSetup.verify': 'Bestätigen',
  'mfaSetup.changePhone': 'Telefonnummer ändern',
  'mfaSetup.backupDescription':
    'Bewahre diesen Wiederherstellungscode an einem sicheren Ort auf. Damit kommst du an dein Konto, wenn du dein Telefon verlierst.',
  'mfaSetup.successHeading': 'Zwei-Faktor-Authentifizierung ist aktiv!',
  'mfaSetup.error.sendCode': 'Der Bestätigungscode konnte nicht gesendet werden.',
  'mfaSetup.error.resend': 'Der Bestätigungscode konnte nicht erneut gesendet werden.',

  'tenant.chooseHeading': 'Workspace auswählen',
  'tenant.error.select': 'Der Workspace konnte nicht ausgewählt werden.',
  'workspace.error.load': 'Deine Workspaces konnten nicht geladen werden.',
  'workspace.error.switch': 'Der Workspace konnte nicht gewechselt werden.',

  'sso.continueWith': 'Weiter mit {provider}',
  'sso.error.popupBlocked':
    'Das Pop-up wurde blockiert. Erlaube Pop-ups und versuche es erneut.',
  'sso.error.login': 'Die Anmeldung ist fehlgeschlagen.',
};

/** Finnish. Finnish has no T/V distinction in product UI; the plain form is used. */
export const fi: Messages = {
  'field.email': 'Sähköposti',
  'field.password': 'Salasana',
  'field.newPassword': 'Uusi salasana',
  'field.confirmPassword': 'Vahvista salasana',
  'field.firstName': 'Etunimi',
  'field.lastName': 'Sukunimi',
  'field.phoneNumber': 'Puhelinnumero',
  'field.verificationCode': 'Vahvistuskoodi',
  'field.authenticationCode': 'Todennuskoodi',
  'field.recoveryCode': 'Palautuskoodi',
  'placeholder.email': 'sina@esimerkki.fi',
  'placeholder.password': 'Kirjoita salasanasi',
  'placeholder.newPassword': 'Vähintään 8 merkkiä',
  'placeholder.confirmPassword': 'Toista salasana',
  'placeholder.firstName': 'Etunimi',
  'placeholder.lastName': 'Sukunimi',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Kirjoita 6-numeroinen koodi',
  'placeholder.recoveryCode': 'Kirjoita palautuskoodi',
  'action.showPassword': 'Näytä salasana',
  'action.hidePassword': 'Piilota salasana',
  'action.showPasswords': 'Näytä salasanat',
  'action.hidePasswords': 'Piilota salasanat',
  'action.backToLogin': 'Takaisin kirjautumiseen',
  'action.backToSignIn': 'Takaisin kirjautumiseen',
  'action.resendCode': 'Lähetä koodi uudelleen',
  'action.copy': 'Kopioi',
  'action.copied': 'Kopioitu!',
  'action.tryAgain': 'Yritä uudelleen',
  'action.done': 'Valmis',
  'divider.or': 'tai',

  'login.heading': 'Kirjaudu tilillesi',
  'login.submit': 'Kirjaudu sisään',
  'login.submitting': 'Kirjaudutaan…',
  'login.forgotPassword': 'Unohtuiko salasana?',
  'login.magicLink': 'Kirjaudu taikalinkillä',
  'login.signupPrompt': 'Eikö sinulla ole tiliä?',
  'login.signupLink': 'Luo tili',
  'login.error.invalidCredentials': 'Virheellinen sähköpostiosoite tai salasana.',

  'forgot.headingRequest': 'Palauta salasanasi',
  'forgot.headingSet': 'Aseta uusi salasana',
  'forgot.description':
    'Kirjoita sähköpostiosoitteesi, niin lähetämme linkin salasanan palauttamiseen.',
  'forgot.submit': 'Lähetä linkki',
  'forgot.setSubmit': 'Aseta salasana',
  'forgot.emailSent': 'Tarkista sähköpostisi — lähetimme linkin salasanan palauttamiseen.',
  'forgot.successHeading': 'Salasana tallennettu',
  'forgot.error.send': 'Linkin lähettäminen ei onnistunut.',
  'forgot.error.update': 'Salasanan päivittäminen ei onnistunut.',
  'forgot.error.mismatch': 'Salasanat eivät täsmää.',
  'forgot.error.tooShort': 'Salasanan pitää olla vähintään 8 merkkiä pitkä.',

  'magicLink.heading': 'Kirjaudu sähköpostilinkillä',
  'magicLink.description':
    'Kirjoita sähköpostiosoitteesi, niin lähetämme kirjautumislinkin. Salasanaa ei tarvita.',
  'magicLink.submit': 'Lähetä taikalinkki',
  'magicLink.sent': 'Tarkista sähköpostisi — linkki vanhenee {expiry} kuluttua.',
  // The three expiry fragments feed "{expiry} kuluttua", which governs the
  // genitive — so they carry the case, and singular and plural are genuinely
  // the same word. Identical values here are correct Finnish, not a copy-paste.
  'magicLink.expiryMinute': '{count} minuutin',
  'magicLink.expiryMinutes': '{count} minuutin',
  'magicLink.expirySeconds': '{count} sekunnin',
  'magicLink.error.send': 'Taikalinkin lähettäminen ei onnistunut.',
  'magicLink.error.auth': 'Kirjautuminen taikalinkillä epäonnistui.',

  'signup.heading': 'Luo tilisi',
  'signup.submit': 'Luo tili',
  'signup.successHeading': 'Tarkista sähköpostisi',
  'signup.successDescription':
    'Lähetimme vahvistuslinkin osoitteeseen {email}. Aktivoi tilisi sähköpostissa olevasta linkistä.',
  'signup.loginPrompt': 'Onko sinulla jo tili?',
  'signup.loginLink': 'Kirjaudu sisään',
  'signup.error.create': 'Tilin luominen ei onnistunut.',

  'passkey.loginButton': 'Kirjaudu passkeyllä',
  'passkey.createHeading': 'Luo passkey',
  'passkey.createPrompt': 'Eikö sinulla ole passkeytä?',
  'passkey.createLink': 'Luo sellainen.',
  'passkey.requestDescription':
    'Kirjoita sähköpostiosoitteesi, niin lähetämme linkin passkeyn luomiseen.',
  'passkey.requestSubmit': 'Lähetä linkki',
  'passkey.sentHeading': 'Tarkista sähköpostisi',
  'passkey.sentDescription':
    'Lähetimme osoitteeseen {email} linkin passkeyn luomista varten. Avaa linkki sähköpostistasi, luo passkey ja viimeistele kirjautuminen.',
  'passkey.settingUpHeading': 'Luodaan passkeytä',
  'passkey.setupHeading': 'Luo passkey',
  'passkey.signInNow': 'Kirjaudu sisään nyt',
  'passkey.requestNewLink': 'Pyydä uusi linkki',
  'passkey.setupDescription':
    'Viimeistele passkeyn luonti seuraamalla selaimen tai laitteen ohjeita.',
  'passkey.setupClickPrompt':
    'Luo passkey tälle laitteelle, niin kirjaudut jatkossa sisään ilman salasanaa.',
  'passkey.setupSubmit': 'Luo passkey',
  'passkey.setupSuccessHeading': 'Passkey luotu',
  'passkey.setupSuccessDescription': 'Passkeysi on luotu.',
  'passkey.error.cancelled': 'Passkeyn luonti peruutettiin.',
  'passkey.error.authCancelled': 'Kirjautuminen passkeyllä peruutettiin.',
  'passkey.error.setupFailed': 'Passkeyn luominen ei onnistunut.',
  'passkey.error.expired': 'Linkki on vanhentunut tai virheellinen.',
  'passkey.error.unsupported': 'Selaimesi ei tue passkeytä.',
  'passkey.error.auth': 'Kirjautuminen passkeyllä epäonnistui.',
  'passkey.error.setup': 'Passkeyn luonnissa tapahtui virhe.',
  'passkey.error.verify': 'Passkeytäsi ei voitu vahvistaa.',
  'passkey.error.sendLink': 'Linkin lähettäminen ei onnistunut.',

  'mfa.challengeHeading': 'Kaksivaiheinen tunnistautuminen',
  'mfa.submit': 'Vahvista',
  'mfa.useRecoveryCode': 'Käytä palautuskoodia',
  'mfa.useAuthenticationCode': 'Käytä todennuskoodia',
  'mfa.recoverSubmit': 'Palauta',
  'mfa.resendPrompt': 'Etkö saanut tekstiviestiä?',
  'mfa.resendCountdown': 'Etkö saanut tekstiviestiä? Voit lähettää uudelleen {seconds} s kuluttua.',
  'mfa.error.invalidCode': 'Virheellinen koodi. Yritä uudelleen.',
  'mfa.error.invalidRecoveryCode': 'Virheellinen palautuskoodi.',
  'mfa.error.resend': 'Koodin lähettäminen uudelleen ei onnistunut.',

  'mfaSetup.heading': 'Ota kaksivaiheinen tunnistautuminen käyttöön',
  'mfaSetup.phoneDescription':
    'Kirjoita puhelinnumerosi, niin lähetämme vahvistuskoodin tekstiviestillä.',
  'mfaSetup.sendCode': 'Lähetä koodi',
  'mfaSetup.verifyDescription': 'Kirjoita puhelimeesi lähetetty 6-numeroinen koodi.',
  'mfaSetup.verify': 'Vahvista',
  'mfaSetup.changePhone': 'Vaihda puhelinnumero',
  'mfaSetup.backupDescription':
    'Säilytä tämä palautuskoodi turvallisessa paikassa. Sen avulla pääset tilillesi, jos puhelimesi katoaa.',
  'mfaSetup.successHeading': 'Kaksivaiheinen tunnistautuminen on käytössä!',
  'mfaSetup.error.sendCode': 'Vahvistuskoodin lähettäminen ei onnistunut.',
  'mfaSetup.error.resend': 'Vahvistuskoodin lähettäminen uudelleen ei onnistunut.',

  'tenant.chooseHeading': 'Valitse työtila',
  'tenant.error.select': 'Työtilan valitseminen ei onnistunut.',
  'workspace.error.load': 'Työtilojen lataaminen ei onnistunut.',
  'workspace.error.switch': 'Työtilan vaihtaminen ei onnistunut.',

  'sso.continueWith': 'Jatka: {provider}',
  'sso.error.popupBlocked':
    'Ponnahdusikkuna estettiin. Salli ponnahdusikkunat ja yritä uudelleen.',
  'sso.error.login': 'Kirjautuminen epäonnistui.',
};

/** French. Informal `tu`. */
export const fr: Messages = {
  'field.email': 'E-mail',
  'field.password': 'Mot de passe',
  'field.newPassword': 'Nouveau mot de passe',
  'field.confirmPassword': 'Confirmer le mot de passe',
  'field.firstName': 'Prénom',
  'field.lastName': 'Nom',
  'field.phoneNumber': 'Numéro de téléphone',
  'field.verificationCode': 'Code de vérification',
  'field.authenticationCode': 'Code d’authentification',
  'field.recoveryCode': 'Code de récupération',
  'placeholder.email': 'toi@exemple.fr',
  'placeholder.password': 'Saisis ton mot de passe',
  'placeholder.newPassword': '8 caractères minimum',
  'placeholder.confirmPassword': 'Répète le mot de passe',
  'placeholder.firstName': 'Prénom',
  'placeholder.lastName': 'Nom',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Saisis le code à 6 chiffres',
  'placeholder.recoveryCode': 'Saisis ton code de récupération',
  'action.showPassword': 'Afficher le mot de passe',
  'action.hidePassword': 'Masquer le mot de passe',
  'action.showPasswords': 'Afficher les mots de passe',
  'action.hidePasswords': 'Masquer les mots de passe',
  'action.backToLogin': 'Retour à la connexion',
  'action.backToSignIn': 'Retour à la connexion',
  'action.resendCode': 'Renvoyer le code',
  'action.copy': 'Copier',
  'action.copied': 'Copié !',
  'action.tryAgain': 'Réessayer',
  'action.done': 'Terminé',
  'divider.or': 'ou',

  'login.heading': 'Connecte-toi à ton compte',
  'login.submit': 'Se connecter',
  'login.submitting': 'Connexion…',
  'login.forgotPassword': 'Mot de passe oublié ?',
  'login.magicLink': 'Se connecter avec un lien magique',
  'login.signupPrompt': 'Tu n’as pas de compte ?',
  'login.signupLink': 'Créer un compte',
  'login.error.invalidCredentials': 'E-mail ou mot de passe incorrect.',

  'forgot.headingRequest': 'Réinitialise ton mot de passe',
  'forgot.headingSet': 'Définis un nouveau mot de passe',
  'forgot.description':
    'Saisis ton e-mail et nous t’enverrons un lien pour réinitialiser ton mot de passe.',
  'forgot.submit': 'Envoyer le lien',
  'forgot.setSubmit': 'Définir un mot de passe',
  'forgot.emailSent': 'Consulte ta boîte mail : le lien de réinitialisation t’attend.',
  'forgot.successHeading': 'Mot de passe enregistré',
  'forgot.error.send': 'Le lien n’a pas pu être envoyé.',
  'forgot.error.update': 'Le mot de passe n’a pas pu être mis à jour.',
  'forgot.error.mismatch': 'Les mots de passe ne correspondent pas.',
  'forgot.error.tooShort': 'Le mot de passe doit comporter au moins 8 caractères.',

  'magicLink.heading': 'Se connecter avec un lien par e-mail',
  'magicLink.description':
    'Saisis ton e-mail et nous t’enverrons un lien de connexion. Aucun mot de passe requis.',
  'magicLink.submit': 'Envoyer le lien magique',
  'magicLink.sent': 'Consulte ta boîte mail — le lien expire dans {expiry}.',
  'magicLink.expiryMinute': '{count} minute',
  'magicLink.expiryMinutes': '{count} minutes',
  'magicLink.expirySeconds': '{count} secondes',
  'magicLink.error.send': 'Le lien magique n’a pas pu être envoyé.',
  'magicLink.error.auth': 'La connexion par lien magique a échoué.',

  'signup.heading': 'Crée ton compte',
  'signup.submit': 'Créer un compte',
  'signup.successHeading': 'Consulte ta boîte mail',
  'signup.successDescription':
    'Nous avons envoyé un lien de vérification à {email}. Ouvre-le pour activer ton compte.',
  'signup.loginPrompt': 'Tu as déjà un compte ?',
  'signup.loginLink': 'Se connecter',
  'signup.error.create': 'Le compte n’a pas pu être créé.',

  'passkey.loginButton': 'Se connecter avec une passkey',
  'passkey.createHeading': 'Créer une passkey',
  'passkey.createPrompt': 'Tu n’as pas de passkey ?',
  'passkey.createLink': 'Crées-en une.',
  'passkey.requestDescription':
    'Saisis ton e-mail et nous t’enverrons un lien pour créer ta passkey.',
  'passkey.requestSubmit': 'Envoyer le lien',
  'passkey.sentHeading': 'Consulte ta boîte mail',
  'passkey.sentDescription':
    'Nous avons envoyé un lien à {email} pour créer ta passkey. Ouvre-le pour créer ta passkey et terminer la connexion.',
  'passkey.settingUpHeading': 'Création de la passkey',
  'passkey.setupHeading': 'Créer une passkey',
  'passkey.signInNow': 'Se connecter maintenant',
  'passkey.requestNewLink': 'Demander un nouveau lien',
  'passkey.setupDescription':
    'Suis les instructions de ton navigateur ou de ton appareil pour terminer la création de ta passkey.',
  'passkey.setupClickPrompt':
    'Crée une passkey sur cet appareil et connecte-toi sans mot de passe à l’avenir.',
  'passkey.setupSubmit': 'Créer la passkey',
  'passkey.setupSuccessHeading': 'Passkey créée',
  'passkey.setupSuccessDescription': 'Ta passkey a été créée.',
  'passkey.error.cancelled': 'La création de la passkey a été annulée.',
  'passkey.error.authCancelled': 'La connexion par passkey a été annulée.',
  'passkey.error.setupFailed': 'Ta passkey n’a pas pu être créée.',
  'passkey.error.expired': 'Ce lien a expiré ou n’est pas valide.',
  'passkey.error.unsupported': 'Ton navigateur ne prend pas en charge les passkeys.',
  'passkey.error.auth': 'La connexion par passkey a échoué.',
  'passkey.error.setup': 'Une erreur s’est produite pendant la création de ta passkey.',
  'passkey.error.verify': 'Ta passkey n’a pas pu être vérifiée.',
  'passkey.error.sendLink': 'Le lien n’a pas pu être envoyé.',

  'mfa.challengeHeading': 'Authentification à deux facteurs',
  'mfa.submit': 'Vérifier',
  'mfa.useRecoveryCode': 'Utiliser un code de récupération',
  'mfa.useAuthenticationCode': 'Utiliser un code d’authentification',
  'mfa.recoverSubmit': 'Récupérer',
  'mfa.resendPrompt': 'Tu n’as pas reçu le SMS ?',
  'mfa.resendCountdown': 'Tu n’as pas reçu le SMS ? Tu pourras le renvoyer dans {seconds} s.',
  'mfa.error.invalidCode': 'Code non valide. Réessaie.',
  'mfa.error.invalidRecoveryCode': 'Code de récupération non valide.',
  'mfa.error.resend': 'Le code n’a pas pu être renvoyé.',

  'mfaSetup.heading': 'Configurer l’authentification à deux facteurs',
  'mfaSetup.phoneDescription':
    'Saisis ton numéro de téléphone pour recevoir un code de vérification par SMS.',
  'mfaSetup.sendCode': 'Envoyer le code',
  'mfaSetup.verifyDescription': 'Saisis le code à 6 chiffres envoyé sur ton téléphone.',
  'mfaSetup.verify': 'Vérifier',
  'mfaSetup.changePhone': 'Changer de numéro',
  'mfaSetup.backupDescription':
    'Conserve ce code de récupération en lieu sûr. Il te permettra d’accéder à ton compte si tu perds ton téléphone.',
  'mfaSetup.successHeading': 'Authentification à deux facteurs activée !',
  'mfaSetup.error.sendCode': 'Le code de vérification n’a pas pu être envoyé.',
  'mfaSetup.error.resend': 'Le code de vérification n’a pas pu être renvoyé.',

  'tenant.chooseHeading': 'Choisis un espace de travail',
  'tenant.error.select': 'L’espace de travail n’a pas pu être sélectionné.',
  'workspace.error.load': 'Tes espaces de travail n’ont pas pu être chargés.',
  'workspace.error.switch': 'Le changement d’espace de travail a échoué.',

  'sso.continueWith': 'Continuer avec {provider}',
  'sso.error.popupBlocked':
    'La fenêtre pop-up a été bloquée. Autorise les pop-ups et réessaie.',
  'sso.error.login': 'La connexion a échoué.',
};

/** Spanish. Informal `tú`. */
export const es: Messages = {
  'field.email': 'Correo electrónico',
  'field.password': 'Contraseña',
  'field.newPassword': 'Nueva contraseña',
  'field.confirmPassword': 'Confirmar contraseña',
  'field.firstName': 'Nombre',
  'field.lastName': 'Apellidos',
  'field.phoneNumber': 'Número de teléfono',
  'field.verificationCode': 'Código de verificación',
  'field.authenticationCode': 'Código de autenticación',
  'field.recoveryCode': 'Código de recuperación',
  'placeholder.email': 'tu@ejemplo.es',
  'placeholder.password': 'Escribe tu contraseña',
  'placeholder.newPassword': 'Mínimo 8 caracteres',
  'placeholder.confirmPassword': 'Repite la contraseña',
  'placeholder.firstName': 'Nombre',
  'placeholder.lastName': 'Apellidos',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Escribe el código de 6 dígitos',
  'placeholder.recoveryCode': 'Escribe tu código de recuperación',
  'action.showPassword': 'Mostrar contraseña',
  'action.hidePassword': 'Ocultar contraseña',
  'action.showPasswords': 'Mostrar contraseñas',
  'action.hidePasswords': 'Ocultar contraseñas',
  'action.backToLogin': 'Volver al inicio de sesión',
  'action.backToSignIn': 'Volver al inicio de sesión',
  'action.resendCode': 'Reenviar código',
  'action.copy': 'Copiar',
  'action.copied': '¡Copiado!',
  'action.tryAgain': 'Inténtalo de nuevo',
  'action.done': 'Hecho',
  'divider.or': 'o',

  'login.heading': 'Inicia sesión en tu cuenta',
  'login.submit': 'Iniciar sesión',
  'login.submitting': 'Iniciando sesión…',
  'login.forgotPassword': '¿Olvidaste tu contraseña?',
  'login.magicLink': 'Iniciar sesión con enlace mágico',
  'login.signupPrompt': '¿Aún no tienes cuenta?',
  'login.signupLink': 'Crear cuenta',
  'login.error.invalidCredentials': 'Correo electrónico o contraseña incorrectos.',

  'forgot.headingRequest': 'Restablece tu contraseña',
  'forgot.headingSet': 'Establece una nueva contraseña',
  'forgot.description':
    'Escribe tu correo electrónico y te enviaremos un enlace para restablecer la contraseña.',
  'forgot.submit': 'Enviar enlace',
  'forgot.setSubmit': 'Establecer contraseña',
  'forgot.emailSent': 'Revisa tu correo: te hemos enviado un enlace para restablecer la contraseña.',
  'forgot.successHeading': 'Contraseña guardada',
  'forgot.error.send': 'No se ha podido enviar el enlace.',
  'forgot.error.update': 'No se ha podido actualizar la contraseña.',
  'forgot.error.mismatch': 'Las contraseñas no coinciden.',
  'forgot.error.tooShort': 'La contraseña debe tener al menos 8 caracteres.',

  'magicLink.heading': 'Inicia sesión con un enlace por correo',
  'magicLink.description':
    'Escribe tu correo electrónico y te enviaremos un enlace de acceso. No necesitas contraseña.',
  'magicLink.submit': 'Enviar enlace mágico',
  'magicLink.sent': 'Revisa tu correo: el enlace caduca en {expiry}.',
  'magicLink.expiryMinute': '{count} minuto',
  'magicLink.expiryMinutes': '{count} minutos',
  'magicLink.expirySeconds': '{count} segundos',
  'magicLink.error.send': 'No se ha podido enviar el enlace mágico.',
  'magicLink.error.auth': 'El inicio de sesión con el enlace mágico ha fallado.',

  'signup.heading': 'Crea tu cuenta',
  'signup.submit': 'Crear cuenta',
  'signup.successHeading': 'Revisa tu correo',
  'signup.successDescription':
    'Hemos enviado un enlace de verificación a {email}. Ábrelo para activar tu cuenta.',
  'signup.loginPrompt': '¿Ya tienes cuenta?',
  'signup.loginLink': 'Iniciar sesión',
  'signup.error.create': 'No se ha podido crear la cuenta.',

  'passkey.loginButton': 'Iniciar sesión con passkey',
  'passkey.createHeading': 'Crear una passkey',
  'passkey.createPrompt': '¿Aún no tienes una passkey?',
  'passkey.createLink': 'Crea una.',
  'passkey.requestDescription':
    'Escribe tu correo electrónico y te enviaremos un enlace para crear tu passkey.',
  'passkey.requestSubmit': 'Enviar enlace',
  'passkey.sentHeading': 'Revisa tu correo',
  'passkey.sentDescription':
    'Hemos enviado un enlace a {email} para crear tu passkey. Ábrelo para crear tu passkey y terminar de iniciar sesión.',
  'passkey.settingUpHeading': 'Creando tu passkey',
  'passkey.setupHeading': 'Crear passkey',
  'passkey.signInNow': 'Iniciar sesión ahora',
  'passkey.requestNewLink': 'Pedir un enlace nuevo',
  'passkey.setupDescription':
    'Sigue las indicaciones de tu navegador o dispositivo para terminar de crear tu passkey.',
  'passkey.setupClickPrompt':
    'Crea una passkey en este dispositivo e inicia sesión sin contraseña a partir de ahora.',
  'passkey.setupSubmit': 'Crear passkey',
  'passkey.setupSuccessHeading': 'Passkey creada',
  'passkey.setupSuccessDescription': 'Tu passkey se ha creado.',
  'passkey.error.cancelled': 'Se ha cancelado la creación de la passkey.',
  'passkey.error.authCancelled': 'Se ha cancelado el inicio de sesión con la passkey.',
  'passkey.error.setupFailed': 'No se ha podido crear tu passkey.',
  'passkey.error.expired': 'Este enlace ha caducado o no es válido.',
  'passkey.error.unsupported': 'Tu navegador no admite passkeys.',
  'passkey.error.auth': 'El inicio de sesión con la passkey ha fallado.',
  'passkey.error.setup': 'Se ha producido un error al crear tu passkey.',
  'passkey.error.verify': 'No se ha podido verificar tu passkey.',
  'passkey.error.sendLink': 'No se ha podido enviar el enlace.',

  'mfa.challengeHeading': 'Verificación en dos pasos',
  'mfa.submit': 'Verificar',
  'mfa.useRecoveryCode': 'Usar código de recuperación',
  'mfa.useAuthenticationCode': 'Usar código de autenticación',
  'mfa.recoverSubmit': 'Recuperar',
  'mfa.resendPrompt': '¿No has recibido el SMS?',
  'mfa.resendCountdown': '¿No has recibido el SMS? Podrás reenviarlo en {seconds} s.',
  'mfa.error.invalidCode': 'Código no válido. Inténtalo de nuevo.',
  'mfa.error.invalidRecoveryCode': 'Código de recuperación no válido.',
  'mfa.error.resend': 'No se ha podido reenviar el código.',

  'mfaSetup.heading': 'Configura la verificación en dos pasos',
  'mfaSetup.phoneDescription':
    'Escribe tu número de teléfono para recibir un código de verificación por SMS.',
  'mfaSetup.sendCode': 'Enviar código',
  'mfaSetup.verifyDescription': 'Escribe el código de 6 dígitos que hemos enviado a tu teléfono.',
  'mfaSetup.verify': 'Verificar',
  'mfaSetup.changePhone': 'Cambiar de número',
  'mfaSetup.backupDescription':
    'Guarda este código de recuperación en un lugar seguro. Te permitirá acceder a tu cuenta si pierdes el teléfono.',
  'mfaSetup.successHeading': '¡Verificación en dos pasos activada!',
  'mfaSetup.error.sendCode': 'No se ha podido enviar el código de verificación.',
  'mfaSetup.error.resend': 'No se ha podido reenviar el código de verificación.',

  'tenant.chooseHeading': 'Elige un espacio de trabajo',
  'tenant.error.select': 'No se ha podido seleccionar el espacio de trabajo.',
  'workspace.error.load': 'No se han podido cargar tus espacios de trabajo.',
  'workspace.error.switch': 'No se ha podido cambiar de espacio de trabajo.',

  'sso.continueWith': 'Continuar con {provider}',
  'sso.error.popupBlocked':
    'Se ha bloqueado la ventana emergente. Permite las ventanas emergentes e inténtalo de nuevo.',
  'sso.error.login': 'El inicio de sesión ha fallado.',
};

/** Italian. Informal `tu`. */
export const it: Messages = {
  'field.email': 'E-mail',
  'field.password': 'Password',
  'field.newPassword': 'Nuova password',
  'field.confirmPassword': 'Conferma password',
  'field.firstName': 'Nome',
  'field.lastName': 'Cognome',
  'field.phoneNumber': 'Numero di telefono',
  'field.verificationCode': 'Codice di verifica',
  'field.authenticationCode': 'Codice di autenticazione',
  'field.recoveryCode': 'Codice di recupero',
  'placeholder.email': 'tu@esempio.it',
  'placeholder.password': 'Inserisci la tua password',
  'placeholder.newPassword': 'Almeno 8 caratteri',
  'placeholder.confirmPassword': 'Ripeti la password',
  'placeholder.firstName': 'Nome',
  'placeholder.lastName': 'Cognome',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Inserisci il codice a 6 cifre',
  'placeholder.recoveryCode': 'Inserisci il codice di recupero',
  'action.showPassword': 'Mostra password',
  'action.hidePassword': 'Nascondi password',
  'action.showPasswords': 'Mostra le password',
  'action.hidePasswords': 'Nascondi le password',
  'action.backToLogin': 'Torna all’accesso',
  'action.backToSignIn': 'Torna all’accesso',
  'action.resendCode': 'Invia di nuovo il codice',
  'action.copy': 'Copia',
  'action.copied': 'Copiato!',
  'action.tryAgain': 'Riprova',
  'action.done': 'Fatto',
  'divider.or': 'oppure',

  'login.heading': 'Accedi al tuo account',
  'login.submit': 'Accedi',
  'login.submitting': 'Accesso in corso…',
  'login.forgotPassword': 'Password dimenticata?',
  'login.magicLink': 'Accedi con un magic link',
  'login.signupPrompt': 'Non hai un account?',
  'login.signupLink': 'Crea un account',
  'login.error.invalidCredentials': 'E-mail o password non corretti.',

  'forgot.headingRequest': 'Reimposta la tua password',
  'forgot.headingSet': 'Imposta una nuova password',
  'forgot.description':
    'Inserisci la tua e-mail e ti invieremo un link per reimpostare la password.',
  'forgot.submit': 'Invia il link',
  'forgot.setSubmit': 'Imposta una password',
  'forgot.emailSent': 'Controlla la tua e-mail: ti abbiamo inviato un link per reimpostare la password.',
  'forgot.successHeading': 'Password salvata',
  'forgot.error.send': 'Non è stato possibile inviare il link.',
  'forgot.error.update': 'Non è stato possibile aggiornare la password.',
  'forgot.error.mismatch': 'Le password non coincidono.',
  'forgot.error.tooShort': 'La password deve contenere almeno 8 caratteri.',

  'magicLink.heading': 'Accedi con un link via e-mail',
  'magicLink.description':
    'Inserisci la tua e-mail e ti invieremo un link di accesso. Nessuna password necessaria.',
  'magicLink.submit': 'Invia il magic link',
  'magicLink.sent': 'Controlla la tua e-mail: il link scade tra {expiry}.',
  'magicLink.expiryMinute': '{count} minuto',
  'magicLink.expiryMinutes': '{count} minuti',
  'magicLink.expirySeconds': '{count} secondi',
  'magicLink.error.send': 'Non è stato possibile inviare il magic link.',
  'magicLink.error.auth': 'Accesso con il magic link non riuscito.',

  'signup.heading': 'Crea il tuo account',
  'signup.submit': 'Crea account',
  'signup.successHeading': 'Controlla la tua e-mail',
  'signup.successDescription':
    'Abbiamo inviato un link di verifica a {email}. Aprilo per attivare il tuo account.',
  'signup.loginPrompt': 'Hai già un account?',
  'signup.loginLink': 'Accedi',
  'signup.error.create': 'Non è stato possibile creare l’account.',

  'passkey.loginButton': 'Accedi con una passkey',
  'passkey.createHeading': 'Crea una passkey',
  'passkey.createPrompt': 'Non hai una passkey?',
  'passkey.createLink': 'Creane una.',
  'passkey.requestDescription':
    'Inserisci la tua e-mail e ti invieremo un link per creare la tua passkey.',
  'passkey.requestSubmit': 'Invia il link',
  'passkey.sentHeading': 'Controlla la tua e-mail',
  'passkey.sentDescription':
    'Abbiamo inviato a {email} un link per creare la tua passkey. Aprilo per creare la passkey e completare l’accesso.',
  'passkey.settingUpHeading': 'Creazione della passkey',
  'passkey.setupHeading': 'Crea la passkey',
  'passkey.signInNow': 'Accedi ora',
  'passkey.requestNewLink': 'Richiedi un nuovo link',
  'passkey.setupDescription':
    'Segui le indicazioni del browser o del dispositivo per completare la creazione della passkey.',
  'passkey.setupClickPrompt':
    'Crea una passkey su questo dispositivo e accedi senza password da ora in poi.',
  'passkey.setupSubmit': 'Crea passkey',
  'passkey.setupSuccessHeading': 'Passkey creata',
  'passkey.setupSuccessDescription': 'La tua passkey è stata creata.',
  'passkey.error.cancelled': 'Creazione della passkey annullata.',
  'passkey.error.authCancelled': 'Accesso con la passkey annullato.',
  'passkey.error.setupFailed': 'Non è stato possibile creare la tua passkey.',
  'passkey.error.expired': 'Questo link è scaduto o non è valido.',
  'passkey.error.unsupported': 'Il tuo browser non supporta le passkey.',
  'passkey.error.auth': 'Accesso con la passkey non riuscito.',
  'passkey.error.setup': 'Si è verificato un errore durante la creazione della passkey.',
  'passkey.error.verify': 'Non è stato possibile verificare la tua passkey.',
  'passkey.error.sendLink': 'Non è stato possibile inviare il link.',

  'mfa.challengeHeading': 'Autenticazione a due fattori',
  'mfa.submit': 'Verifica',
  'mfa.useRecoveryCode': 'Usa un codice di recupero',
  'mfa.useAuthenticationCode': 'Usa un codice di autenticazione',
  'mfa.recoverSubmit': 'Recupera',
  'mfa.resendPrompt': 'Non hai ricevuto l’SMS?',
  'mfa.resendCountdown': 'Non hai ricevuto l’SMS? Potrai inviarlo di nuovo tra {seconds} s.',
  'mfa.error.invalidCode': 'Codice non valido. Riprova.',
  'mfa.error.invalidRecoveryCode': 'Codice di recupero non valido.',
  'mfa.error.resend': 'Non è stato possibile inviare di nuovo il codice.',

  'mfaSetup.heading': 'Configura l’autenticazione a due fattori',
  'mfaSetup.phoneDescription':
    'Inserisci il tuo numero di telefono per ricevere un codice di verifica via SMS.',
  'mfaSetup.sendCode': 'Invia il codice',
  'mfaSetup.verifyDescription': 'Inserisci il codice a 6 cifre inviato al tuo telefono.',
  'mfaSetup.verify': 'Verifica',
  'mfaSetup.changePhone': 'Cambia numero di telefono',
  'mfaSetup.backupDescription':
    'Conserva questo codice di recupero in un posto sicuro. Ti servirà per accedere al tuo account se perdi il telefono.',
  'mfaSetup.successHeading': 'Autenticazione a due fattori attivata!',
  'mfaSetup.error.sendCode': 'Non è stato possibile inviare il codice di verifica.',
  'mfaSetup.error.resend': 'Non è stato possibile inviare di nuovo il codice di verifica.',

  'tenant.chooseHeading': 'Scegli uno spazio di lavoro',
  'tenant.error.select': 'Non è stato possibile selezionare lo spazio di lavoro.',
  'workspace.error.load': 'Non è stato possibile caricare i tuoi spazi di lavoro.',
  'workspace.error.switch': 'Non è stato possibile cambiare spazio di lavoro.',

  'sso.continueWith': 'Continua con {provider}',
  'sso.error.popupBlocked':
    'Il pop-up è stato bloccato. Consenti i pop-up e riprova.',
  'sso.error.login': 'Accesso non riuscito.',
};

/** Portuguese (European). Informal `tu`. */
export const pt: Messages = {
  'field.email': 'E-mail',
  'field.password': 'Palavra-passe',
  'field.newPassword': 'Nova palavra-passe',
  'field.confirmPassword': 'Confirmar palavra-passe',
  'field.firstName': 'Nome próprio',
  'field.lastName': 'Apelido',
  'field.phoneNumber': 'Número de telefone',
  'field.verificationCode': 'Código de verificação',
  'field.authenticationCode': 'Código de autenticação',
  'field.recoveryCode': 'Código de recuperação',
  'placeholder.email': 'tu@exemplo.pt',
  'placeholder.password': 'Introduz a tua palavra-passe',
  'placeholder.newPassword': 'Pelo menos 8 caracteres',
  'placeholder.confirmPassword': 'Repete a palavra-passe',
  'placeholder.firstName': 'Nome próprio',
  'placeholder.lastName': 'Apelido',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Introduz o código de 6 dígitos',
  'placeholder.recoveryCode': 'Introduz o código de recuperação',
  'action.showPassword': 'Mostrar palavra-passe',
  'action.hidePassword': 'Ocultar palavra-passe',
  'action.showPasswords': 'Mostrar palavras-passe',
  'action.hidePasswords': 'Ocultar palavras-passe',
  'action.backToLogin': 'Voltar ao início de sessão',
  'action.backToSignIn': 'Voltar ao início de sessão',
  'action.resendCode': 'Reenviar código',
  'action.copy': 'Copiar',
  'action.copied': 'Copiado!',
  'action.tryAgain': 'Tenta novamente',
  'action.done': 'Concluído',
  'divider.or': 'ou',

  'login.heading': 'Inicia sessão na tua conta',
  'login.submit': 'Iniciar sessão',
  'login.submitting': 'A iniciar sessão…',
  'login.forgotPassword': 'Esqueceste-te da palavra-passe?',
  'login.magicLink': 'Iniciar sessão com link mágico',
  'login.signupPrompt': 'Ainda não tens conta?',
  'login.signupLink': 'Criar conta',
  'login.error.invalidCredentials': 'E-mail ou palavra-passe incorretos.',

  'forgot.headingRequest': 'Repõe a tua palavra-passe',
  'forgot.headingSet': 'Define uma nova palavra-passe',
  'forgot.description':
    'Introduz o teu e-mail e enviamos-te um link para repores a palavra-passe.',
  'forgot.submit': 'Enviar link',
  'forgot.setSubmit': 'Definir palavra-passe',
  'forgot.emailSent': 'Vê o teu e-mail: enviámos um link para repor a palavra-passe.',
  'forgot.successHeading': 'Palavra-passe guardada',
  'forgot.error.send': 'Não foi possível enviar o link.',
  'forgot.error.update': 'Não foi possível atualizar a palavra-passe.',
  'forgot.error.mismatch': 'As palavras-passe não coincidem.',
  'forgot.error.tooShort': 'A palavra-passe tem de ter pelo menos 8 caracteres.',

  'magicLink.heading': 'Inicia sessão com um link por e-mail',
  'magicLink.description':
    'Introduz o teu e-mail e enviamos-te um link de acesso. Não precisas de palavra-passe.',
  'magicLink.submit': 'Enviar link mágico',
  'magicLink.sent': 'Vê o teu e-mail — o link expira daqui a {expiry}.',
  'magicLink.expiryMinute': '{count} minuto',
  'magicLink.expiryMinutes': '{count} minutos',
  'magicLink.expirySeconds': '{count} segundos',
  'magicLink.error.send': 'Não foi possível enviar o link mágico.',
  'magicLink.error.auth': 'O início de sessão com o link mágico falhou.',

  'signup.heading': 'Cria a tua conta',
  'signup.submit': 'Criar conta',
  'signup.successHeading': 'Vê o teu e-mail',
  'signup.successDescription':
    'Enviámos um link de verificação para {email}. Abre-o para ativares a tua conta.',
  'signup.loginPrompt': 'Já tens conta?',
  'signup.loginLink': 'Iniciar sessão',
  'signup.error.create': 'Não foi possível criar a conta.',

  'passkey.loginButton': 'Iniciar sessão com passkey',
  'passkey.createHeading': 'Criar uma passkey',
  'passkey.createPrompt': 'Ainda não tens uma passkey?',
  'passkey.createLink': 'Cria uma.',
  'passkey.requestDescription':
    'Introduz o teu e-mail e enviamos-te um link para criares a tua passkey.',
  'passkey.requestSubmit': 'Enviar link',
  'passkey.sentHeading': 'Vê o teu e-mail',
  'passkey.sentDescription':
    'Enviámos para {email} um link para criares a tua passkey. Abre-o para criares a passkey e concluíres o início de sessão.',
  'passkey.settingUpHeading': 'A criar a tua passkey',
  'passkey.setupHeading': 'Criar passkey',
  'passkey.signInNow': 'Iniciar sessão agora',
  'passkey.requestNewLink': 'Pedir um novo link',
  'passkey.setupDescription':
    'Segue as indicações do teu navegador ou dispositivo para concluíres a criação da passkey.',
  'passkey.setupClickPrompt':
    'Cria uma passkey neste dispositivo e inicia sessão sem palavra-passe a partir de agora.',
  'passkey.setupSubmit': 'Criar passkey',
  'passkey.setupSuccessHeading': 'Passkey criada',
  'passkey.setupSuccessDescription': 'A tua passkey foi criada.',
  'passkey.error.cancelled': 'A criação da passkey foi cancelada.',
  'passkey.error.authCancelled': 'O início de sessão com a passkey foi cancelado.',
  'passkey.error.setupFailed': 'Não foi possível criar a tua passkey.',
  'passkey.error.expired': 'Este link expirou ou não é válido.',
  'passkey.error.unsupported': 'O teu navegador não suporta passkeys.',
  'passkey.error.auth': 'O início de sessão com a passkey falhou.',
  'passkey.error.setup': 'Ocorreu um erro ao criar a tua passkey.',
  'passkey.error.verify': 'Não foi possível verificar a tua passkey.',
  'passkey.error.sendLink': 'Não foi possível enviar o link.',

  'mfa.challengeHeading': 'Autenticação de dois fatores',
  'mfa.submit': 'Verificar',
  'mfa.useRecoveryCode': 'Usar código de recuperação',
  'mfa.useAuthenticationCode': 'Usar código de autenticação',
  'mfa.recoverSubmit': 'Recuperar',
  'mfa.resendPrompt': 'Não recebeste a SMS?',
  'mfa.resendCountdown': 'Não recebeste a SMS? Podes reenviar daqui a {seconds} s.',
  'mfa.error.invalidCode': 'Código inválido. Tenta novamente.',
  'mfa.error.invalidRecoveryCode': 'Código de recuperação inválido.',
  'mfa.error.resend': 'Não foi possível reenviar o código.',

  'mfaSetup.heading': 'Configura a autenticação de dois fatores',
  'mfaSetup.phoneDescription':
    'Introduz o teu número de telefone para receberes um código de verificação por SMS.',
  'mfaSetup.sendCode': 'Enviar código',
  'mfaSetup.verifyDescription': 'Introduz o código de 6 dígitos enviado para o teu telefone.',
  'mfaSetup.verify': 'Verificar',
  'mfaSetup.changePhone': 'Alterar número de telefone',
  'mfaSetup.backupDescription':
    'Guarda este código de recuperação num sítio seguro. Podes usá-lo para aceder à tua conta se perderes o telefone.',
  'mfaSetup.successHeading': 'Autenticação de dois fatores ativada!',
  'mfaSetup.error.sendCode': 'Não foi possível enviar o código de verificação.',
  'mfaSetup.error.resend': 'Não foi possível reenviar o código de verificação.',

  'tenant.chooseHeading': 'Escolhe um espaço de trabalho',
  'tenant.error.select': 'Não foi possível selecionar o espaço de trabalho.',
  'workspace.error.load': 'Não foi possível carregar os teus espaços de trabalho.',
  'workspace.error.switch': 'Não foi possível mudar de espaço de trabalho.',

  'sso.continueWith': 'Continuar com {provider}',
  'sso.error.popupBlocked':
    'A janela pop-up foi bloqueada. Permite pop-ups e tenta novamente.',
  'sso.error.login': 'O início de sessão falhou.',
};

/** Polish. Informal `ty`. */
export const pl: Messages = {
  'field.email': 'E-mail',
  'field.password': 'Hasło',
  'field.newPassword': 'Nowe hasło',
  'field.confirmPassword': 'Potwierdź hasło',
  'field.firstName': 'Imię',
  'field.lastName': 'Nazwisko',
  'field.phoneNumber': 'Numer telefonu',
  'field.verificationCode': 'Kod weryfikacyjny',
  'field.authenticationCode': 'Kod uwierzytelniający',
  'field.recoveryCode': 'Kod odzyskiwania',
  'placeholder.email': 'ty@przyklad.pl',
  'placeholder.password': 'Wpisz swoje hasło',
  'placeholder.newPassword': 'Co najmniej 8 znaków',
  'placeholder.confirmPassword': 'Powtórz hasło',
  'placeholder.firstName': 'Imię',
  'placeholder.lastName': 'Nazwisko',
  'placeholder.phoneNumber': '',
  'placeholder.sixDigitCode': 'Wpisz 6-cyfrowy kod',
  'placeholder.recoveryCode': 'Wpisz kod odzyskiwania',
  'action.showPassword': 'Pokaż hasło',
  'action.hidePassword': 'Ukryj hasło',
  'action.showPasswords': 'Pokaż hasła',
  'action.hidePasswords': 'Ukryj hasła',
  'action.backToLogin': 'Wróć do logowania',
  'action.backToSignIn': 'Wróć do logowania',
  'action.resendCode': 'Wyślij kod ponownie',
  'action.copy': 'Kopiuj',
  'action.copied': 'Skopiowano!',
  'action.tryAgain': 'Spróbuj ponownie',
  'action.done': 'Gotowe',
  'divider.or': 'lub',

  'login.heading': 'Zaloguj się na swoje konto',
  'login.submit': 'Zaloguj się',
  'login.submitting': 'Logowanie…',
  'login.forgotPassword': 'Nie pamiętasz hasła?',
  'login.magicLink': 'Zaloguj się magicznym linkiem',
  'login.signupPrompt': 'Nie masz jeszcze konta?',
  'login.signupLink': 'Załóż konto',
  'login.error.invalidCredentials': 'Nieprawidłowy e-mail lub hasło.',

  'forgot.headingRequest': 'Zresetuj hasło',
  'forgot.headingSet': 'Ustaw nowe hasło',
  'forgot.description':
    'Podaj swój e-mail, a wyślemy Ci link do zresetowania hasła.',
  'forgot.submit': 'Wyślij link',
  'forgot.setSubmit': 'Ustaw hasło',
  'forgot.emailSent': 'Sprawdź skrzynkę — wysłaliśmy link do zresetowania hasła.',
  'forgot.successHeading': 'Hasło zapisane',
  'forgot.error.send': 'Nie udało się wysłać linku.',
  'forgot.error.update': 'Nie udało się zaktualizować hasła.',
  'forgot.error.mismatch': 'Hasła nie są takie same.',
  'forgot.error.tooShort': 'Hasło musi mieć co najmniej 8 znaków.',

  'magicLink.heading': 'Zaloguj się linkiem z e-maila',
  'magicLink.description':
    'Podaj swój e-mail, a wyślemy Ci link do logowania. Hasło nie jest potrzebne.',
  'magicLink.submit': 'Wyślij magiczny link',
  'magicLink.sent': 'Sprawdź skrzynkę — link wygasa za {expiry}.',
  // Polish needs three plural forms (1 / 2-4 / 5+), and the catalogue offers
  // two. Rather than render "za 5 minuty", the plural fragments abbreviate to
  // the unit symbol, which is invariant. Revisit if the catalogue ever grows a
  // real plural rule.
  'magicLink.expiryMinute': '{count} minutę',
  'magicLink.expiryMinutes': '{count} min',
  'magicLink.expirySeconds': '{count} s',
  'magicLink.error.send': 'Nie udało się wysłać magicznego linku.',
  'magicLink.error.auth': 'Logowanie magicznym linkiem nie powiodło się.',

  'signup.heading': 'Załóż konto',
  'signup.submit': 'Załóż konto',
  'signup.successHeading': 'Sprawdź skrzynkę',
  'signup.successDescription':
    'Wysłaliśmy link weryfikacyjny na adres {email}. Otwórz go, aby aktywować konto.',
  'signup.loginPrompt': 'Masz już konto?',
  'signup.loginLink': 'Zaloguj się',
  'signup.error.create': 'Nie udało się założyć konta.',

  'passkey.loginButton': 'Zaloguj się kluczem passkey',
  'passkey.createHeading': 'Utwórz klucz passkey',
  'passkey.createPrompt': 'Nie masz jeszcze klucza passkey?',
  'passkey.createLink': 'Utwórz go.',
  'passkey.requestDescription':
    'Podaj swój e-mail, a wyślemy Ci link do utworzenia klucza passkey.',
  'passkey.requestSubmit': 'Wyślij link',
  'passkey.sentHeading': 'Sprawdź skrzynkę',
  'passkey.sentDescription':
    'Wysłaliśmy na adres {email} link do utworzenia klucza passkey. Otwórz go, aby utworzyć klucz i dokończyć logowanie.',
  'passkey.settingUpHeading': 'Tworzenie klucza passkey',
  'passkey.setupHeading': 'Utwórz klucz passkey',
  'passkey.signInNow': 'Zaloguj się teraz',
  'passkey.requestNewLink': 'Poproś o nowy link',
  'passkey.setupDescription':
    'Postępuj zgodnie ze wskazówkami przeglądarki lub urządzenia, aby dokończyć tworzenie klucza passkey.',
  'passkey.setupClickPrompt':
    'Utwórz klucz passkey na tym urządzeniu i loguj się od teraz bez hasła.',
  'passkey.setupSubmit': 'Utwórz passkey',
  'passkey.setupSuccessHeading': 'Klucz passkey utworzony',
  'passkey.setupSuccessDescription': 'Twój klucz passkey został utworzony.',
  'passkey.error.cancelled': 'Tworzenie klucza passkey zostało anulowane.',
  'passkey.error.authCancelled': 'Logowanie kluczem passkey zostało anulowane.',
  'passkey.error.setupFailed': 'Nie udało się utworzyć klucza passkey.',
  'passkey.error.expired': 'Ten link wygasł lub jest nieprawidłowy.',
  'passkey.error.unsupported': 'Twoja przeglądarka nie obsługuje kluczy passkey.',
  'passkey.error.auth': 'Logowanie kluczem passkey nie powiodło się.',
  'passkey.error.setup': 'Podczas tworzenia klucza passkey wystąpił błąd.',
  'passkey.error.verify': 'Nie udało się zweryfikować klucza passkey.',
  'passkey.error.sendLink': 'Nie udało się wysłać linku.',

  'mfa.challengeHeading': 'Uwierzytelnianie dwuskładnikowe',
  'mfa.submit': 'Zweryfikuj',
  'mfa.useRecoveryCode': 'Użyj kodu odzyskiwania',
  'mfa.useAuthenticationCode': 'Użyj kodu uwierzytelniającego',
  'mfa.recoverSubmit': 'Odzyskaj',
  'mfa.resendPrompt': 'Nie dotarł SMS?',
  'mfa.resendCountdown': 'Nie dotarł SMS? Możesz wysłać ponownie za {seconds} s.',
  'mfa.error.invalidCode': 'Nieprawidłowy kod. Spróbuj ponownie.',
  'mfa.error.invalidRecoveryCode': 'Nieprawidłowy kod odzyskiwania.',
  'mfa.error.resend': 'Nie udało się wysłać kodu ponownie.',

  'mfaSetup.heading': 'Włącz uwierzytelnianie dwuskładnikowe',
  'mfaSetup.phoneDescription':
    'Podaj numer telefonu, aby otrzymać kod weryfikacyjny w SMS-ie.',
  'mfaSetup.sendCode': 'Wyślij kod',
  'mfaSetup.verifyDescription': 'Wpisz 6-cyfrowy kod wysłany na Twój telefon.',
  'mfaSetup.verify': 'Zweryfikuj',
  'mfaSetup.changePhone': 'Zmień numer telefonu',
  'mfaSetup.backupDescription':
    'Zapisz ten kod odzyskiwania w bezpiecznym miejscu. Pozwoli Ci wejść na konto, jeśli zgubisz telefon.',
  'mfaSetup.successHeading': 'Uwierzytelnianie dwuskładnikowe włączone!',
  'mfaSetup.error.sendCode': 'Nie udało się wysłać kodu weryfikacyjnego.',
  'mfaSetup.error.resend': 'Nie udało się ponownie wysłać kodu weryfikacyjnego.',

  'tenant.chooseHeading': 'Wybierz przestrzeń roboczą',
  'tenant.error.select': 'Nie udało się wybrać przestrzeni roboczej.',
  'workspace.error.load': 'Nie udało się wczytać Twoich przestrzeni roboczych.',
  'workspace.error.switch': 'Nie udało się zmienić przestrzeni roboczej.',

  'sso.continueWith': 'Kontynuuj z {provider}',
  'sso.error.popupBlocked':
    'Wyskakujące okienko zostało zablokowane. Zezwól na wyskakujące okienka i spróbuj ponownie.',
  'sso.error.login': 'Logowanie nie powiodło się.',
};

/**
 * Locales shipping with the package. Adding one is data-only.
 *
 * Keys are the primary subtag only; `normalizeLocale` maps `de-AT` → `de`, so a
 * region variant needs its own entry only when the copy genuinely differs.
 */
export const LOCALES: Record<string, Messages> = {
  da,
  de,
  en,
  es,
  fi,
  fr,
  it,
  nb,
  nl,
  pl,
  pt,
  sv,
};
