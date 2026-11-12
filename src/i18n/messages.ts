/**
 * Message catalogue for the SDK auth components.
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
 * rather than catalogue entries.
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
  'placeholder.email': string;
  'placeholder.password': string;
  'placeholder.newPassword': string;
  'placeholder.confirmPassword': string;
  'placeholder.firstName': string;
  'placeholder.lastName': string;
  'placeholder.phoneNumber': string;
  'action.showPassword': string;
  'action.hidePassword': string;
  'action.showPasswords': string;
  'action.hidePasswords': string;
  'action.backToLogin': string;
  'action.backToSignIn': string;
  'action.copy': string;
  'action.copied': string;
  'action.tryAgain': string;
  'action.done': string;

  // Login
  'login.heading': string;
  'login.submit': string;
  /** In-flight label on the login button. */
  'login.submitting': string;
  'login.forgotPassword': string;
  'login.signupPrompt': string;
  'login.signupLink': string;
  'login.error.invalidCredentials': string;
  /** The page's address is not one of the app's registered addresses (`origin-not-allowed`). `{origin}` is that address. */
  'error.originNotAllowed': string;

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

  // Signup
  'signup.heading': string;
  'signup.submit': string;
  'signup.successHeading': string;
  /** Interpolates {email}. */
  'signup.successDescription': string;
  'signup.loginPrompt': string;
  'signup.loginLink': string;
  'signup.error.create': string;

  // Workspace selection
  /**
   * Heading on the workspace picker that renders MID-LOGIN, between
   * authenticating and landing, for a user who belongs to several tenants.
   * Untranslated it put one English screen in the middle of an otherwise
   * translated flow — more jarring than a consistently English login.
   */
  'workspace.chooseHeading': string;
  'workspace.error.select': string;
  'workspace.error.load': string;
  'workspace.error.switch': string;

  // Sign-up from its email link, links, and errors any flow can meet
  /** Shown while an email link finishes sign-up. */
  'verify.finishing': string;
  /** The sign-up link was opened on another device; it still works on the right one. */
  'verify.error.wrongDevice': string;
  'link.error.invalid': string;
  'login.error.flowExpired': string;
  'login.error.unsupportedStep': string;
  'error.unavailable': string;
  'error.network': string;
  'error.rateLimited': string;
  /** Sign-in protection paused the account or the address. Interpolates {minutes}, 2 or more. */
  'login.error.tooManyAttempts': string;
  /** Sign-in protection paused the account or the address, for 1 minute: the singular of `login.error.tooManyAttempts`. */
  'login.error.tooManyAttemptsOneMinute': string;
  /** Sign-in protection locked the account until its password is reset. */
  'login.error.accountLocked': string;
  /** Hand-off sign-in for a program on this machine. Interpolates {program}. */
  'handoff.heading': string;
  /** Interpolates {program}. */
  'handoff.done': string;
  'action.signOut': string;
  /** Interpolates {workspace}. */
  'invite.heading': string;
  'invite.accept': string;
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
  'placeholder.email': 'you@example.com',
  'placeholder.password': 'Enter your password',
  'placeholder.newPassword': 'At least 8 characters',
  'placeholder.confirmPassword': 'Repeat password',
  'placeholder.firstName': 'First name',
  'placeholder.lastName': 'Last name',
  // Empty on purpose. A format hint that is wrong for most of the audience is worse
  // than none, and the field already has a label.
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Show password',
  'action.hidePassword': 'Hide password',
  'action.showPasswords': 'Show passwords',
  'action.hidePasswords': 'Hide passwords',
  'action.backToLogin': 'Back to login',
  'action.backToSignIn': 'Back to sign in',
  'action.copy': 'Copy',
  'action.copied': 'Copied!',
  'action.tryAgain': 'Try again',
  'action.done': 'Done',

  'login.heading': 'Log in to your account',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.forgotPassword': 'Forgot password?',
  'login.signupPrompt': "Don't have an account?",
  'login.signupLink': 'Sign up',
  'login.error.invalidCredentials': 'Invalid email or password.',
  'error.originNotAllowed': 'This page\'s address, {origin}, is not one of this app\'s registered addresses in Bridge.',

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

  'signup.heading': 'Create your account',
  'signup.submit': 'Sign up',
  'signup.successHeading': 'Check your email',
  'signup.successDescription':
    'We sent a verification link to {email}. Check your inbox to activate your account.',
  'signup.loginPrompt': 'Already have an account?',
  'signup.loginLink': 'Log in',
  'signup.error.create': 'Failed to create account.',

  'workspace.chooseHeading': 'Choose a workspace',
  'workspace.error.select': 'Failed to select workspace.',
  'workspace.error.load': 'Failed to load workspaces.',
  'workspace.error.switch': 'Failed to switch workspace.',


  'verify.finishing': 'Finishing sign-up…',
  'verify.error.wrongDevice': 'Open the link on the device you signed up on.',
  'link.error.invalid': 'This link is no longer valid. Ask for a new one.',
  'login.error.flowExpired': 'That took too long. Please sign in again.',
  'login.error.unsupportedStep': 'This workspace needs a sign-in step this app does not offer yet.',
  'error.unavailable': 'This is not available right now. Please try again shortly.',
  'error.network': 'Could not connect. Check your connection and try again.',
  'error.rateLimited': 'Too many attempts. Please wait a moment and try again.',
  'login.error.tooManyAttempts': 'Too many attempts. Try again in {minutes} minutes.',
  'login.error.tooManyAttemptsOneMinute': 'Too many attempts. Try again in 1 minute.',
  'login.error.accountLocked': 'Too many attempts. This account is locked. Reset your password to sign in again.',
  'handoff.heading': 'Sign in to {program}',
  'handoff.done': 'You are signed in. You can close this tab and go back to {program}.',
  'action.signOut': 'Sign out',
  'invite.heading': 'Join {workspace}',
  'invite.accept': 'Accept invite',
};

/**
 * Swedish.
 *
 * ## Register and house style, applied to every locale below
 *
 * These were the two hand-checked locales; the other ten follow the
 * conventions this one set, so read it as the reference before adding an
 * eleventh.
 *
 * - **Informal address** wherever the language distinguishes it — `du`, `tu`,
 *   `jij`, `ty`. This is a product login, not a bank letter.
 * - **Errors are impersonal.** "The code could not be sent", not "we failed to
 *   send". The user did not do anything wrong and does not care who did.
 * - **Errors end in a full stop; labels and buttons do not.**
 * - **`placeholder.phoneNumber` stays empty in every locale.** A format hint
 *   that is wrong for the reader is worse than none.
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
  'placeholder.email': 'du@exempel.se',
  'placeholder.password': 'Ange ditt lösenord',
  'placeholder.newPassword': 'Minst 8 tecken',
  'placeholder.confirmPassword': 'Upprepa lösenordet',
  'placeholder.firstName': 'Förnamn',
  'placeholder.lastName': 'Efternamn',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Visa lösenord',
  'action.hidePassword': 'Dölj lösenord',
  'action.showPasswords': 'Visa lösenord',
  'action.hidePasswords': 'Dölj lösenord',
  'action.backToLogin': 'Tillbaka till inloggningen',
  'action.backToSignIn': 'Tillbaka till inloggningen',
  'action.copy': 'Kopiera',
  'action.copied': 'Kopierad!',
  'action.tryAgain': 'Försök igen',
  'action.done': 'Klar',

  'login.heading': 'Logga in på ditt konto',
  'login.submit': 'Logga in',
  'login.submitting': 'Loggar in…',
  'login.forgotPassword': 'Glömt lösenordet?',
  'login.signupPrompt': 'Har du inget konto?',
  'login.signupLink': 'Skapa konto',
  'login.error.invalidCredentials': 'Fel e-postadress eller lösenord.',
  'error.originNotAllowed': 'Sidans adress, {origin}, är inte en av appens registrerade adresser i Bridge.',

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

  'signup.heading': 'Skapa ditt konto',
  'signup.submit': 'Skapa konto',
  'signup.successHeading': 'Kolla din e-post',
  'signup.successDescription':
    'Vi har skickat en verifieringslänk till {email}. Kolla inkorgen för att aktivera ditt konto.',
  'signup.loginPrompt': 'Har du redan ett konto?',
  'signup.loginLink': 'Logga in',
  'signup.error.create': 'Det gick inte att skapa kontot.',

  'workspace.chooseHeading': 'Välj arbetsyta',
  'workspace.error.select': 'Det gick inte att välja arbetsyta.',
  'workspace.error.load': 'Det gick inte att hämta dina arbetsytor.',
  'workspace.error.switch': 'Det gick inte att byta arbetsyta.',


  'verify.finishing': 'Slutför registreringen…',
  'verify.error.wrongDevice': 'Öppna länken på enheten där du registrerade dig.',
  'link.error.invalid': 'Länken är inte längre giltig. Be om en ny.',
  'login.error.flowExpired': 'Det tog för lång tid. Logga in igen.',
  'login.error.unsupportedStep': 'Den här arbetsytan kräver ett inloggningssteg som appen inte erbjuder ännu.',
  'error.unavailable': 'Det går inte just nu. Försök igen om en stund.',
  'error.network': 'Det gick inte att ansluta. Kontrollera anslutningen och försök igen.',
  'error.rateLimited': 'För många försök. Vänta en stund och försök igen.',
  'login.error.tooManyAttempts': 'För många försök. Försök igen om {minutes} minuter.',
  'login.error.tooManyAttemptsOneMinute': 'För många försök. Försök igen om 1 minut.',
  'login.error.accountLocked': 'För många försök. Kontot är låst. Återställ ditt lösenord för att logga in igen.',
  'handoff.heading': 'Logga in i {program}',
  'handoff.done': 'Du är inloggad. Du kan stänga fliken och gå tillbaka till {program}.',
  'action.signOut': 'Logga ut',
  'invite.heading': 'Gå med i {workspace}',
  'invite.accept': 'Acceptera inbjudan',
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
  'placeholder.email': 'du@eksempel.dk',
  'placeholder.password': 'Indtast din adgangskode',
  'placeholder.newPassword': 'Mindst 8 tegn',
  'placeholder.confirmPassword': 'Gentag adgangskoden',
  'placeholder.firstName': 'Fornavn',
  'placeholder.lastName': 'Efternavn',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Vis adgangskode',
  'action.hidePassword': 'Skjul adgangskode',
  'action.showPasswords': 'Vis adgangskoder',
  'action.hidePasswords': 'Skjul adgangskoder',
  'action.backToLogin': 'Tilbage til login',
  'action.backToSignIn': 'Tilbage til login',
  'action.copy': 'Kopiér',
  'action.copied': 'Kopieret!',
  'action.tryAgain': 'Prøv igen',
  'action.done': 'Færdig',

  'login.heading': 'Log ind på din konto',
  'login.submit': 'Log ind',
  'login.submitting': 'Logger ind…',
  'login.forgotPassword': 'Glemt adgangskode?',
  'login.signupPrompt': 'Har du ikke en konto?',
  'login.signupLink': 'Opret konto',
  'login.error.invalidCredentials': 'Forkert e-mail eller adgangskode.',
  'error.originNotAllowed': 'Sidens adresse, {origin}, er ikke en af appens registrerede adresser i Bridge.',

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

  'signup.heading': 'Opret din konto',
  'signup.submit': 'Opret konto',
  'signup.successHeading': 'Tjek din e-mail',
  'signup.successDescription':
    'Vi har sendt et bekræftelseslink til {email}. Tjek din indbakke for at aktivere din konto.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Log ind',
  'signup.error.create': 'Kontoen kunne ikke oprettes.',

  'workspace.chooseHeading': 'Vælg et arbejdsområde',
  'workspace.error.select': 'Arbejdsområdet kunne ikke vælges.',
  'workspace.error.load': 'Dine arbejdsområder kunne ikke hentes.',
  'workspace.error.switch': 'Der kunne ikke skiftes arbejdsområde.',


  'verify.finishing': 'Afslutter tilmeldingen…',
  'verify.error.wrongDevice': 'Åbn linket på den enhed, du tilmeldte dig på.',
  'link.error.invalid': 'Linket er ikke længere gyldigt. Bed om et nyt.',
  'login.error.flowExpired': 'Det tog for lang tid. Log ind igen.',
  'login.error.unsupportedStep': 'Dette arbejdsområde kræver et login-trin, som appen ikke tilbyder endnu.',
  'error.unavailable': 'Det er ikke tilgængeligt lige nu. Prøv igen om lidt.',
  'error.network': 'Der kunne ikke oprettes forbindelse. Tjek din forbindelse, og prøv igen.',
  'error.rateLimited': 'For mange forsøg. Vent et øjeblik, og prøv igen.',
  'login.error.tooManyAttempts': 'For mange forsøg. Prøv igen om {minutes} minutter.',
  'login.error.tooManyAttemptsOneMinute': 'For mange forsøg. Prøv igen om 1 minut.',
  'login.error.accountLocked': 'For mange forsøg. Kontoen er låst. Nulstil din adgangskode for at logge ind igen.',
  'handoff.heading': 'Log ind på {program}',
  'handoff.done': 'Du er logget ind. Du kan lukke fanen og gå tilbage til {program}.',
  'action.signOut': 'Log ud',
  'invite.heading': 'Bliv medlem af {workspace}',
  'invite.accept': 'Accepter invitationen',
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
  'placeholder.email': 'du@eksempel.no',
  'placeholder.password': 'Skriv inn passordet ditt',
  'placeholder.newPassword': 'Minst 8 tegn',
  'placeholder.confirmPassword': 'Gjenta passordet',
  'placeholder.firstName': 'Fornavn',
  'placeholder.lastName': 'Etternavn',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Vis passord',
  'action.hidePassword': 'Skjul passord',
  'action.showPasswords': 'Vis passord',
  'action.hidePasswords': 'Skjul passord',
  'action.backToLogin': 'Tilbake til innlogging',
  'action.backToSignIn': 'Tilbake til innlogging',
  'action.copy': 'Kopier',
  'action.copied': 'Kopiert!',
  'action.tryAgain': 'Prøv igjen',
  'action.done': 'Ferdig',

  'login.heading': 'Logg inn på kontoen din',
  'login.submit': 'Logg inn',
  'login.submitting': 'Logger inn…',
  'login.forgotPassword': 'Glemt passord?',
  'login.signupPrompt': 'Har du ingen konto?',
  'login.signupLink': 'Opprett konto',
  'login.error.invalidCredentials': 'Feil e-postadresse eller passord.',
  'error.originNotAllowed': 'Sidens adresse, {origin}, er ikke en av appens registrerte adresser i Bridge.',

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

  'signup.heading': 'Opprett kontoen din',
  'signup.submit': 'Opprett konto',
  'signup.successHeading': 'Sjekk e-posten din',
  'signup.successDescription':
    'Vi har sendt en bekreftelseslenke til {email}. Sjekk innboksen for å aktivere kontoen din.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Logg inn',
  'signup.error.create': 'Kontoen kunne ikke opprettes.',

  'workspace.chooseHeading': 'Velg et arbeidsområde',
  'workspace.error.select': 'Arbeidsområdet kunne ikke velges.',
  'workspace.error.load': 'Arbeidsområdene dine kunne ikke hentes.',
  'workspace.error.switch': 'Kunne ikke bytte arbeidsområde.',


  'verify.finishing': 'Fullfører registreringen…',
  'verify.error.wrongDevice': 'Åpne lenken på enheten du registrerte deg på.',
  'link.error.invalid': 'Lenken er ikke lenger gyldig. Be om en ny.',
  'login.error.flowExpired': 'Det tok for lang tid. Logg inn på nytt.',
  'login.error.unsupportedStep': 'Dette arbeidsområdet krever et innloggingstrinn som appen ikke tilbyr ennå.',
  'error.unavailable': 'Det er ikke tilgjengelig akkurat nå. Prøv igjen om litt.',
  'error.network': 'Kunne ikke koble til. Sjekk tilkoblingen og prøv igjen.',
  'error.rateLimited': 'For mange forsøk. Vent litt og prøv igjen.',
  'login.error.tooManyAttempts': 'For mange forsøk. Prøv igjen om {minutes} minutter.',
  'login.error.tooManyAttemptsOneMinute': 'For mange forsøk. Prøv igjen om 1 minutt.',
  'login.error.accountLocked': 'For mange forsøk. Kontoen er låst. Tilbakestill passordet for å logge inn igjen.',
  'handoff.heading': 'Logg inn på {program}',
  'handoff.done': 'Du er logget inn. Du kan lukke fanen og gå tilbake til {program}.',
  'action.signOut': 'Logg ut',
  'invite.heading': 'Bli med i {workspace}',
  'invite.accept': 'Godta invitasjonen',
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
  'placeholder.email': 'jij@voorbeeld.nl',
  'placeholder.password': 'Voer je wachtwoord in',
  'placeholder.newPassword': 'Minimaal 8 tekens',
  'placeholder.confirmPassword': 'Herhaal het wachtwoord',
  'placeholder.firstName': 'Voornaam',
  'placeholder.lastName': 'Achternaam',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Wachtwoord tonen',
  'action.hidePassword': 'Wachtwoord verbergen',
  'action.showPasswords': 'Wachtwoorden tonen',
  'action.hidePasswords': 'Wachtwoorden verbergen',
  'action.backToLogin': 'Terug naar inloggen',
  'action.backToSignIn': 'Terug naar inloggen',
  'action.copy': 'Kopiëren',
  'action.copied': 'Gekopieerd!',
  'action.tryAgain': 'Opnieuw proberen',
  'action.done': 'Klaar',

  'login.heading': 'Log in op je account',
  'login.submit': 'Inloggen',
  'login.submitting': 'Bezig met inloggen…',
  'login.forgotPassword': 'Wachtwoord vergeten?',
  'login.signupPrompt': 'Nog geen account?',
  'login.signupLink': 'Account aanmaken',
  'login.error.invalidCredentials': 'Onjuist e-mailadres of wachtwoord.',
  'error.originNotAllowed': 'Het adres van deze pagina, {origin}, is niet een van de geregistreerde adressen van deze app in Bridge.',

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

  'signup.heading': 'Maak je account aan',
  'signup.submit': 'Account aanmaken',
  'signup.successHeading': 'Check je e-mail',
  'signup.successDescription':
    'We hebben een verificatielink naar {email} gestuurd. Check je inbox om je account te activeren.',
  'signup.loginPrompt': 'Heb je al een account?',
  'signup.loginLink': 'Inloggen',
  'signup.error.create': 'Het account kon niet worden aangemaakt.',

  'workspace.chooseHeading': 'Kies een workspace',
  'workspace.error.select': 'De workspace kon niet worden geselecteerd.',
  'workspace.error.load': 'Je workspaces konden niet worden geladen.',
  'workspace.error.switch': 'Wisselen van workspace is niet gelukt.',


  'verify.finishing': 'Aanmelding afronden…',
  'verify.error.wrongDevice': 'Open de link op het apparaat waarop je je hebt aangemeld.',
  'link.error.invalid': 'Deze link is niet meer geldig. Vraag een nieuwe aan.',
  'login.error.flowExpired': 'Dat duurde te lang. Log opnieuw in.',
  'login.error.unsupportedStep': 'Deze workspace vraagt een inlogstap die deze app nog niet biedt.',
  'error.unavailable': 'Dit is nu niet beschikbaar. Probeer het zo meteen opnieuw.',
  'error.network': 'Kan geen verbinding maken. Controleer je verbinding en probeer het opnieuw.',
  'error.rateLimited': 'Te veel pogingen. Wacht even en probeer het opnieuw.',
  'login.error.tooManyAttempts': 'Te veel pogingen. Probeer het over {minutes} minuten opnieuw.',
  'login.error.tooManyAttemptsOneMinute': 'Te veel pogingen. Probeer het over 1 minuut opnieuw.',
  'login.error.accountLocked': 'Te veel pogingen. Dit account is vergrendeld. Stel je wachtwoord opnieuw in om weer in te loggen.',
  'handoff.heading': 'Inloggen bij {program}',
  'handoff.done': 'Je bent ingelogd. Je kunt dit tabblad sluiten en teruggaan naar {program}.',
  'action.signOut': 'Uitloggen',
  'invite.heading': 'Word lid van {workspace}',
  'invite.accept': 'Uitnodiging accepteren',
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
  'placeholder.email': 'du@beispiel.de',
  'placeholder.password': 'Passwort eingeben',
  'placeholder.newPassword': 'Mindestens 8 Zeichen',
  'placeholder.confirmPassword': 'Passwort wiederholen',
  'placeholder.firstName': 'Vorname',
  'placeholder.lastName': 'Nachname',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Passwort anzeigen',
  'action.hidePassword': 'Passwort verbergen',
  'action.showPasswords': 'Passwörter anzeigen',
  'action.hidePasswords': 'Passwörter verbergen',
  'action.backToLogin': 'Zurück zur Anmeldung',
  'action.backToSignIn': 'Zurück zur Anmeldung',
  'action.copy': 'Kopieren',
  'action.copied': 'Kopiert!',
  'action.tryAgain': 'Erneut versuchen',
  'action.done': 'Fertig',

  'login.heading': 'Bei deinem Konto anmelden',
  'login.submit': 'Anmelden',
  'login.submitting': 'Anmeldung läuft…',
  'login.forgotPassword': 'Passwort vergessen?',
  'login.signupPrompt': 'Noch kein Konto?',
  'login.signupLink': 'Konto erstellen',
  'login.error.invalidCredentials': 'E-Mail-Adresse oder Passwort ist falsch.',
  'error.originNotAllowed': 'Die Adresse dieser Seite, {origin}, gehört nicht zu den registrierten Adressen dieser App in Bridge.',

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

  'signup.heading': 'Konto erstellen',
  'signup.submit': 'Konto erstellen',
  'signup.successHeading': 'Sieh in deinem Postfach nach',
  'signup.successDescription':
    'Wir haben einen Bestätigungslink an {email} geschickt. Sieh in deinem Postfach nach, um dein Konto zu aktivieren.',
  'signup.loginPrompt': 'Du hast schon ein Konto?',
  'signup.loginLink': 'Anmelden',
  'signup.error.create': 'Das Konto konnte nicht erstellt werden.',

  'workspace.chooseHeading': 'Workspace auswählen',
  'workspace.error.select': 'Der Workspace konnte nicht ausgewählt werden.',
  'workspace.error.load': 'Deine Workspaces konnten nicht geladen werden.',
  'workspace.error.switch': 'Der Workspace konnte nicht gewechselt werden.',


  'verify.finishing': 'Registrierung wird abgeschlossen…',
  'verify.error.wrongDevice': 'Öffne den Link auf dem Gerät, auf dem du dich registriert hast.',
  'link.error.invalid': 'Dieser Link ist nicht mehr gültig. Fordere einen neuen an.',
  'login.error.flowExpired': 'Das hat zu lange gedauert. Melde dich erneut an.',
  'login.error.unsupportedStep': 'Dieser Workspace verlangt einen Anmeldeschritt, den diese App noch nicht anbietet.',
  'error.unavailable': 'Das ist gerade nicht verfügbar. Versuche es gleich noch einmal.',
  'error.network': 'Keine Verbindung möglich. Prüfe deine Verbindung und versuche es erneut.',
  'error.rateLimited': 'Zu viele Versuche. Warte einen Moment und versuche es erneut.',
  'login.error.tooManyAttempts': 'Zu viele Versuche. Versuchen Sie es in {minutes} Minuten erneut.',
  'login.error.tooManyAttemptsOneMinute': 'Zu viele Versuche. Versuchen Sie es in 1 Minute erneut.',
  'login.error.accountLocked': 'Zu viele Versuche. Dieses Konto ist gesperrt. Setzen Sie Ihr Passwort zurück, um sich wieder anzumelden.',
  'handoff.heading': 'Bei {program} anmelden',
  'handoff.done': 'Du bist angemeldet. Du kannst diesen Tab schließen und zu {program} zurückkehren.',
  'action.signOut': 'Abmelden',
  'invite.heading': '{workspace} beitreten',
  'invite.accept': 'Einladung annehmen',
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
  'placeholder.email': 'sina@esimerkki.fi',
  'placeholder.password': 'Kirjoita salasanasi',
  'placeholder.newPassword': 'Vähintään 8 merkkiä',
  'placeholder.confirmPassword': 'Toista salasana',
  'placeholder.firstName': 'Etunimi',
  'placeholder.lastName': 'Sukunimi',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Näytä salasana',
  'action.hidePassword': 'Piilota salasana',
  'action.showPasswords': 'Näytä salasanat',
  'action.hidePasswords': 'Piilota salasanat',
  'action.backToLogin': 'Takaisin kirjautumiseen',
  'action.backToSignIn': 'Takaisin kirjautumiseen',
  'action.copy': 'Kopioi',
  'action.copied': 'Kopioitu!',
  'action.tryAgain': 'Yritä uudelleen',
  'action.done': 'Valmis',

  'login.heading': 'Kirjaudu tilillesi',
  'login.submit': 'Kirjaudu sisään',
  'login.submitting': 'Kirjaudutaan…',
  'login.forgotPassword': 'Unohtuiko salasana?',
  'login.signupPrompt': 'Eikö sinulla ole tiliä?',
  'login.signupLink': 'Luo tili',
  'login.error.invalidCredentials': 'Virheellinen sähköpostiosoite tai salasana.',
  'error.originNotAllowed': 'Tämän sivun osoite, {origin}, ei ole yksi sovelluksen rekisteröidyistä osoitteista Bridgessä.',

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

  'signup.heading': 'Luo tilisi',
  'signup.submit': 'Luo tili',
  'signup.successHeading': 'Tarkista sähköpostisi',
  'signup.successDescription':
    'Lähetimme vahvistuslinkin osoitteeseen {email}. Aktivoi tilisi sähköpostissa olevasta linkistä.',
  'signup.loginPrompt': 'Onko sinulla jo tili?',
  'signup.loginLink': 'Kirjaudu sisään',
  'signup.error.create': 'Tilin luominen ei onnistunut.',

  'workspace.chooseHeading': 'Valitse työtila',
  'workspace.error.select': 'Työtilan valitseminen ei onnistunut.',
  'workspace.error.load': 'Työtilojen lataaminen ei onnistunut.',
  'workspace.error.switch': 'Työtilan vaihtaminen ei onnistunut.',


  'verify.finishing': 'Viimeistellään rekisteröitymistä…',
  'verify.error.wrongDevice': 'Avaa linkki laitteella, jolla rekisteröidyit.',
  'link.error.invalid': 'Linkki ei ole enää voimassa. Pyydä uusi.',
  'login.error.flowExpired': 'Se kesti liian kauan. Kirjaudu sisään uudelleen.',
  'login.error.unsupportedStep': 'Tämä työtila vaatii kirjautumisvaiheen, jota sovellus ei vielä tarjoa.',
  'error.unavailable': 'Tämä ei ole juuri nyt käytettävissä. Yritä hetken päästä uudelleen.',
  'error.network': 'Yhteyttä ei saatu. Tarkista yhteys ja yritä uudelleen.',
  'error.rateLimited': 'Liian monta yritystä. Odota hetki ja yritä uudelleen.',
  'login.error.tooManyAttempts': 'Liian monta yritystä. Yritä uudelleen {minutes} minuutin kuluttua.',
  'login.error.tooManyAttemptsOneMinute': 'Liian monta yritystä. Yritä uudelleen 1 minuutin kuluttua.',
  'login.error.accountLocked': 'Liian monta yritystä. Tili on lukittu. Vaihda salasana kirjautuaksesi uudelleen.',
  'handoff.heading': 'Kirjaudu sovellukseen {program}',
  'handoff.done': 'Olet kirjautunut sisään. Voit sulkea välilehden ja palata sovellukseen {program}.',
  'action.signOut': 'Kirjaudu ulos',
  'invite.heading': 'Liity työtilaan {workspace}',
  'invite.accept': 'Hyväksy kutsu',
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
  'placeholder.email': 'toi@exemple.fr',
  'placeholder.password': 'Saisis ton mot de passe',
  'placeholder.newPassword': '8 caractères minimum',
  'placeholder.confirmPassword': 'Répète le mot de passe',
  'placeholder.firstName': 'Prénom',
  'placeholder.lastName': 'Nom',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Afficher le mot de passe',
  'action.hidePassword': 'Masquer le mot de passe',
  'action.showPasswords': 'Afficher les mots de passe',
  'action.hidePasswords': 'Masquer les mots de passe',
  'action.backToLogin': 'Retour à la connexion',
  'action.backToSignIn': 'Retour à la connexion',
  'action.copy': 'Copier',
  'action.copied': 'Copié !',
  'action.tryAgain': 'Réessayer',
  'action.done': 'Terminé',

  'login.heading': 'Connecte-toi à ton compte',
  'login.submit': 'Se connecter',
  'login.submitting': 'Connexion…',
  'login.forgotPassword': 'Mot de passe oublié ?',
  'login.signupPrompt': 'Tu n’as pas de compte ?',
  'login.signupLink': 'Créer un compte',
  'login.error.invalidCredentials': 'E-mail ou mot de passe incorrect.',
  'error.originNotAllowed': 'L’adresse de cette page, {origin}, ne fait pas partie des adresses enregistrées de cette appli dans Bridge.',

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

  'signup.heading': 'Crée ton compte',
  'signup.submit': 'Créer un compte',
  'signup.successHeading': 'Consulte ta boîte mail',
  'signup.successDescription':
    'Nous avons envoyé un lien de vérification à {email}. Ouvre-le pour activer ton compte.',
  'signup.loginPrompt': 'Tu as déjà un compte ?',
  'signup.loginLink': 'Se connecter',
  'signup.error.create': 'Le compte n’a pas pu être créé.',

  'workspace.chooseHeading': 'Choisis un espace de travail',
  'workspace.error.select': 'L’espace de travail n’a pas pu être sélectionné.',
  'workspace.error.load': 'Tes espaces de travail n’ont pas pu être chargés.',
  'workspace.error.switch': 'Le changement d’espace de travail a échoué.',


  'verify.finishing': 'Finalisation de l’inscription…',
  'verify.error.wrongDevice': 'Ouvre le lien sur l’appareil avec lequel tu t’es inscrit.',
  'link.error.invalid': 'Ce lien n’est plus valide. Demandes-en un nouveau.',
  'login.error.flowExpired': 'C’était trop long. Reconnecte-toi.',
  'login.error.unsupportedStep': 'Cet espace de travail demande une étape de connexion que cette appli ne propose pas encore.',
  'error.unavailable': 'Ce n’est pas disponible pour le moment. Réessaie dans un instant.',
  'error.network': 'Connexion impossible. Vérifie ta connexion et réessaie.',
  'error.rateLimited': 'Trop de tentatives. Patiente un instant et réessaie.',
  'login.error.tooManyAttempts': 'Trop de tentatives. Réessayez dans {minutes} minutes.',
  'login.error.tooManyAttemptsOneMinute': 'Trop de tentatives. Réessayez dans 1 minute.',
  'login.error.accountLocked': 'Trop de tentatives. Ce compte est verrouillé. Réinitialisez votre mot de passe pour vous reconnecter.',
  'handoff.heading': 'Se connecter à {program}',
  'handoff.done': 'Tu es connecté. Tu peux fermer cet onglet et revenir à {program}.',
  'action.signOut': 'Se déconnecter',
  'invite.heading': 'Rejoindre {workspace}',
  'invite.accept': 'Accepter l’invitation',
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
  'placeholder.email': 'tu@ejemplo.es',
  'placeholder.password': 'Escribe tu contraseña',
  'placeholder.newPassword': 'Mínimo 8 caracteres',
  'placeholder.confirmPassword': 'Repite la contraseña',
  'placeholder.firstName': 'Nombre',
  'placeholder.lastName': 'Apellidos',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Mostrar contraseña',
  'action.hidePassword': 'Ocultar contraseña',
  'action.showPasswords': 'Mostrar contraseñas',
  'action.hidePasswords': 'Ocultar contraseñas',
  'action.backToLogin': 'Volver al inicio de sesión',
  'action.backToSignIn': 'Volver al inicio de sesión',
  'action.copy': 'Copiar',
  'action.copied': '¡Copiado!',
  'action.tryAgain': 'Inténtalo de nuevo',
  'action.done': 'Hecho',

  'login.heading': 'Inicia sesión en tu cuenta',
  'login.submit': 'Iniciar sesión',
  'login.submitting': 'Iniciando sesión…',
  'login.forgotPassword': '¿Olvidaste tu contraseña?',
  'login.signupPrompt': '¿Aún no tienes cuenta?',
  'login.signupLink': 'Crear cuenta',
  'login.error.invalidCredentials': 'Correo electrónico o contraseña incorrectos.',
  'error.originNotAllowed': 'La dirección de esta página, {origin}, no es una de las direcciones registradas de esta app en Bridge.',

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

  'signup.heading': 'Crea tu cuenta',
  'signup.submit': 'Crear cuenta',
  'signup.successHeading': 'Revisa tu correo',
  'signup.successDescription':
    'Hemos enviado un enlace de verificación a {email}. Ábrelo para activar tu cuenta.',
  'signup.loginPrompt': '¿Ya tienes cuenta?',
  'signup.loginLink': 'Iniciar sesión',
  'signup.error.create': 'No se ha podido crear la cuenta.',

  'workspace.chooseHeading': 'Elige un espacio de trabajo',
  'workspace.error.select': 'No se ha podido seleccionar el espacio de trabajo.',
  'workspace.error.load': 'No se han podido cargar tus espacios de trabajo.',
  'workspace.error.switch': 'No se ha podido cambiar de espacio de trabajo.',


  'verify.finishing': 'Completando el registro…',
  'verify.error.wrongDevice': 'Abre el enlace en el dispositivo con el que te registraste.',
  'link.error.invalid': 'Este enlace ya no es válido. Pide uno nuevo.',
  'login.error.flowExpired': 'Ha tardado demasiado. Vuelve a iniciar sesión.',
  'login.error.unsupportedStep': 'Este espacio de trabajo pide un paso de inicio de sesión que esta app aún no ofrece.',
  'error.unavailable': 'No está disponible ahora mismo. Inténtalo de nuevo en un momento.',
  'error.network': 'No se pudo conectar. Comprueba tu conexión e inténtalo de nuevo.',
  'error.rateLimited': 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
  'login.error.tooManyAttempts': 'Demasiados intentos. Inténtalo de nuevo en {minutes} minutos.',
  'login.error.tooManyAttemptsOneMinute': 'Demasiados intentos. Inténtalo de nuevo en 1 minuto.',
  'login.error.accountLocked': 'Demasiados intentos. Esta cuenta está bloqueada. Restablece tu contraseña para volver a iniciar sesión.',
  'handoff.heading': 'Iniciar sesión en {program}',
  'handoff.done': 'Has iniciado sesión. Puedes cerrar esta pestaña y volver a {program}.',
  'action.signOut': 'Cerrar sesión',
  'invite.heading': 'Unirte a {workspace}',
  'invite.accept': 'Aceptar la invitación',
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
  'placeholder.email': 'tu@esempio.it',
  'placeholder.password': 'Inserisci la tua password',
  'placeholder.newPassword': 'Almeno 8 caratteri',
  'placeholder.confirmPassword': 'Ripeti la password',
  'placeholder.firstName': 'Nome',
  'placeholder.lastName': 'Cognome',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Mostra password',
  'action.hidePassword': 'Nascondi password',
  'action.showPasswords': 'Mostra le password',
  'action.hidePasswords': 'Nascondi le password',
  'action.backToLogin': 'Torna all’accesso',
  'action.backToSignIn': 'Torna all’accesso',
  'action.copy': 'Copia',
  'action.copied': 'Copiato!',
  'action.tryAgain': 'Riprova',
  'action.done': 'Fatto',

  'login.heading': 'Accedi al tuo account',
  'login.submit': 'Accedi',
  'login.submitting': 'Accesso in corso…',
  'login.forgotPassword': 'Password dimenticata?',
  'login.signupPrompt': 'Non hai un account?',
  'login.signupLink': 'Crea un account',
  'login.error.invalidCredentials': 'E-mail o password non corretti.',
  'error.originNotAllowed': 'L’indirizzo di questa pagina, {origin}, non è tra gli indirizzi registrati di questa app in Bridge.',

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

  'signup.heading': 'Crea il tuo account',
  'signup.submit': 'Crea account',
  'signup.successHeading': 'Controlla la tua e-mail',
  'signup.successDescription':
    'Abbiamo inviato un link di verifica a {email}. Aprilo per attivare il tuo account.',
  'signup.loginPrompt': 'Hai già un account?',
  'signup.loginLink': 'Accedi',
  'signup.error.create': 'Non è stato possibile creare l’account.',

  'workspace.chooseHeading': 'Scegli uno spazio di lavoro',
  'workspace.error.select': 'Non è stato possibile selezionare lo spazio di lavoro.',
  'workspace.error.load': 'Non è stato possibile caricare i tuoi spazi di lavoro.',
  'workspace.error.switch': 'Non è stato possibile cambiare spazio di lavoro.',


  'verify.finishing': 'Completamento della registrazione…',
  'verify.error.wrongDevice': 'Apri il link sul dispositivo con cui ti sei registrato.',
  'link.error.invalid': 'Questo link non è più valido. Richiedine uno nuovo.',
  'login.error.flowExpired': 'Ci è voluto troppo tempo. Accedi di nuovo.',
  'login.error.unsupportedStep': 'Questo spazio di lavoro richiede un passaggio di accesso che questa app non offre ancora.',
  'error.unavailable': 'Non è disponibile in questo momento. Riprova tra poco.',
  'error.network': 'Impossibile connettersi. Controlla la connessione e riprova.',
  'error.rateLimited': 'Troppi tentativi. Attendi un momento e riprova.',
  'login.error.tooManyAttempts': 'Troppi tentativi. Riprova tra {minutes} minuti.',
  'login.error.tooManyAttemptsOneMinute': 'Troppi tentativi. Riprova tra 1 minuto.',
  'login.error.accountLocked': 'Troppi tentativi. Questo account è bloccato. Reimposta la password per accedere di nuovo.',
  'handoff.heading': 'Accedi a {program}',
  'handoff.done': 'Hai effettuato l’accesso. Puoi chiudere questa scheda e tornare a {program}.',
  'action.signOut': 'Esci',
  'invite.heading': 'Unisciti a {workspace}',
  'invite.accept': 'Accetta l’invito',
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
  'placeholder.email': 'tu@exemplo.pt',
  'placeholder.password': 'Introduz a tua palavra-passe',
  'placeholder.newPassword': 'Pelo menos 8 caracteres',
  'placeholder.confirmPassword': 'Repete a palavra-passe',
  'placeholder.firstName': 'Nome próprio',
  'placeholder.lastName': 'Apelido',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Mostrar palavra-passe',
  'action.hidePassword': 'Ocultar palavra-passe',
  'action.showPasswords': 'Mostrar palavras-passe',
  'action.hidePasswords': 'Ocultar palavras-passe',
  'action.backToLogin': 'Voltar ao início de sessão',
  'action.backToSignIn': 'Voltar ao início de sessão',
  'action.copy': 'Copiar',
  'action.copied': 'Copiado!',
  'action.tryAgain': 'Tenta novamente',
  'action.done': 'Concluído',

  'login.heading': 'Inicia sessão na tua conta',
  'login.submit': 'Iniciar sessão',
  'login.submitting': 'A iniciar sessão…',
  'login.forgotPassword': 'Esqueceste-te da palavra-passe?',
  'login.signupPrompt': 'Ainda não tens conta?',
  'login.signupLink': 'Criar conta',
  'login.error.invalidCredentials': 'E-mail ou palavra-passe incorretos.',
  'error.originNotAllowed': 'O endereço desta página, {origin}, não é um dos endereços registados desta app no Bridge.',

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

  'signup.heading': 'Cria a tua conta',
  'signup.submit': 'Criar conta',
  'signup.successHeading': 'Vê o teu e-mail',
  'signup.successDescription':
    'Enviámos um link de verificação para {email}. Abre-o para ativares a tua conta.',
  'signup.loginPrompt': 'Já tens conta?',
  'signup.loginLink': 'Iniciar sessão',
  'signup.error.create': 'Não foi possível criar a conta.',

  'workspace.chooseHeading': 'Escolhe um espaço de trabalho',
  'workspace.error.select': 'Não foi possível selecionar o espaço de trabalho.',
  'workspace.error.load': 'Não foi possível carregar os teus espaços de trabalho.',
  'workspace.error.switch': 'Não foi possível mudar de espaço de trabalho.',


  'verify.finishing': 'A concluir o registo…',
  'verify.error.wrongDevice': 'Abre a ligação no dispositivo em que te registaste.',
  'link.error.invalid': 'Esta ligação já não é válida. Pede uma nova.',
  'login.error.flowExpired': 'Demorou demasiado. Inicia sessão novamente.',
  'login.error.unsupportedStep': 'Este espaço de trabalho pede um passo de início de sessão que esta app ainda não oferece.',
  'error.unavailable': 'Não está disponível neste momento. Tenta novamente daqui a pouco.',
  'error.network': 'Não foi possível ligar. Verifica a tua ligação e tenta novamente.',
  'error.rateLimited': 'Demasiadas tentativas. Aguarda um momento e tenta novamente.',
  'login.error.tooManyAttempts': 'Demasiadas tentativas. Tenta novamente dentro de {minutes} minutos.',
  'login.error.tooManyAttemptsOneMinute': 'Demasiadas tentativas. Tenta novamente dentro de 1 minuto.',
  'login.error.accountLocked': 'Demasiadas tentativas. Esta conta está bloqueada. Redefine a tua palavra-passe para voltar a iniciar sessão.',
  'handoff.heading': 'Iniciar sessão em {program}',
  'handoff.done': 'Tens sessão iniciada. Podes fechar este separador e voltar a {program}.',
  'action.signOut': 'Terminar sessão',
  'invite.heading': 'Juntar-te a {workspace}',
  'invite.accept': 'Aceitar o convite',
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
  'placeholder.email': 'ty@przyklad.pl',
  'placeholder.password': 'Wpisz swoje hasło',
  'placeholder.newPassword': 'Co najmniej 8 znaków',
  'placeholder.confirmPassword': 'Powtórz hasło',
  'placeholder.firstName': 'Imię',
  'placeholder.lastName': 'Nazwisko',
  'placeholder.phoneNumber': '',
  'action.showPassword': 'Pokaż hasło',
  'action.hidePassword': 'Ukryj hasło',
  'action.showPasswords': 'Pokaż hasła',
  'action.hidePasswords': 'Ukryj hasła',
  'action.backToLogin': 'Wróć do logowania',
  'action.backToSignIn': 'Wróć do logowania',
  'action.copy': 'Kopiuj',
  'action.copied': 'Skopiowano!',
  'action.tryAgain': 'Spróbuj ponownie',
  'action.done': 'Gotowe',

  'login.heading': 'Zaloguj się na swoje konto',
  'login.submit': 'Zaloguj się',
  'login.submitting': 'Logowanie…',
  'login.forgotPassword': 'Nie pamiętasz hasła?',
  'login.signupPrompt': 'Nie masz jeszcze konta?',
  'login.signupLink': 'Załóż konto',
  'login.error.invalidCredentials': 'Nieprawidłowy e-mail lub hasło.',
  'error.originNotAllowed': 'Adres tej strony, {origin}, nie należy do zarejestrowanych adresów tej aplikacji w Bridge.',

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

  'signup.heading': 'Załóż konto',
  'signup.submit': 'Załóż konto',
  'signup.successHeading': 'Sprawdź skrzynkę',
  'signup.successDescription':
    'Wysłaliśmy link weryfikacyjny na adres {email}. Otwórz go, aby aktywować konto.',
  'signup.loginPrompt': 'Masz już konto?',
  'signup.loginLink': 'Zaloguj się',
  'signup.error.create': 'Nie udało się założyć konta.',

  'workspace.chooseHeading': 'Wybierz przestrzeń roboczą',
  'workspace.error.select': 'Nie udało się wybrać przestrzeni roboczej.',
  'workspace.error.load': 'Nie udało się wczytać Twoich przestrzeni roboczych.',
  'workspace.error.switch': 'Nie udało się zmienić przestrzeni roboczej.',


  'verify.finishing': 'Kończenie rejestracji…',
  'verify.error.wrongDevice': 'Otwórz link na urządzeniu, na którym się rejestrowałeś.',
  'link.error.invalid': 'Ten link nie jest już ważny. Poproś o nowy.',
  'login.error.flowExpired': 'Trwało to zbyt długo. Zaloguj się ponownie.',
  'login.error.unsupportedStep': 'Ta przestrzeń robocza wymaga kroku logowania, którego ta aplikacja jeszcze nie oferuje.',
  'error.unavailable': 'Ta funkcja jest teraz niedostępna. Spróbuj ponownie za chwilę.',
  'error.network': 'Nie udało się połączyć. Sprawdź połączenie i spróbuj ponownie.',
  'error.rateLimited': 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.',
  'login.error.tooManyAttempts': 'Zbyt wiele prób. Spróbuj ponownie za {minutes} min.',
  'login.error.tooManyAttemptsOneMinute': 'Zbyt wiele prób. Spróbuj ponownie za minutę.',
  'login.error.accountLocked': 'Zbyt wiele prób. To konto jest zablokowane. Zresetuj hasło, aby zalogować się ponownie.',
  'handoff.heading': 'Zaloguj się do {program}',
  'handoff.done': 'Jesteś zalogowany. Możesz zamknąć tę kartę i wrócić do {program}.',
  'action.signOut': 'Wyloguj się',
  'invite.heading': 'Dołącz do {workspace}',
  'invite.accept': 'Przyjmij zaproszenie',
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
