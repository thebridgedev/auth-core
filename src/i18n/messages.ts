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
  'action.backToLogin': 'Back to sign in',
  'action.backToSignIn': 'Back to sign in',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.tryAgain': 'Try again',
  'action.done': 'Done',

  'login.heading': 'Sign in to your account',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.forgotPassword': 'Forgot password?',
  'login.signupPrompt': "Don't have an account?",
  'login.signupLink': "Create account",
  'login.error.invalidCredentials': 'Wrong email or password. Try again, or reset your password.',
  'error.originNotAllowed': "This page's address, {origin}, is not registered for this app in Bridge. Ask the app's owner to add it.",

  'forgot.headingRequest': 'Reset your password',
  'forgot.headingSet': "Choose a new password",
  'forgot.description': "Enter your email and we'll send you a link to reset your password.",
  'forgot.submit': 'Send reset link',
  'forgot.setSubmit': 'Save new password',
  'forgot.emailSent': 'If this address has an account, a link to reset your password is on its way.',
  'forgot.successHeading': "Password saved",
  'forgot.error.send': 'The link could not be sent. Try again in a moment.',
  'forgot.error.update': 'Your password could not be changed. Try again, or ask for a new link.',
  'forgot.error.mismatch': 'Passwords do not match.',
  'forgot.error.tooShort': "Use at least 8 characters.",

  'signup.heading': 'Create your account',
  'signup.submit': 'Create account',
  'signup.successHeading': 'Check your email',
  'signup.successDescription':
    'We sent a link to {email}. Open it to finish creating your account.',
  'signup.loginPrompt': 'Already have an account?',
  'signup.loginLink': 'Sign in',
  'signup.error.create': 'Your account could not be created. Try again in a moment.',

  'workspace.chooseHeading': 'Choose a workspace',
  'workspace.error.select': 'That workspace could not be opened. Try again.',
  'workspace.error.load': 'Your workspaces could not be loaded. Try again.',
  'workspace.error.switch': 'The workspace could not be changed. Try again.',


  'verify.finishing': 'Finishing sign-up…',
  'verify.error.wrongDevice': 'This link works only in the browser where you signed up. Open it there, or sign up again here.',
  'link.error.invalid': 'This link is no longer valid. Ask for a new one.',
  'login.error.flowExpired': "That took too long. Sign in again.",
  'login.error.unsupportedStep': 'Your workspace asks for a sign-in step that is not available here yet. Ask your workspace admin for help.',
  'error.unavailable': "This is not available right now. Try again in a moment.",
  'error.network': 'Could not connect. Check your connection and try again.',
  'error.rateLimited': "Too many attempts. Wait a moment, then try again.",
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
  'action.copied': 'Kopierad',
  'action.tryAgain': 'Försök igen',
  'action.done': 'Klar',

  'login.heading': 'Logga in på ditt konto',
  'login.submit': 'Logga in',
  'login.submitting': 'Loggar in…',
  'login.forgotPassword': 'Glömt lösenordet?',
  'login.signupPrompt': 'Har du inget konto?',
  'login.signupLink': 'Skapa konto',
  'login.error.invalidCredentials': 'Fel e-postadress eller lösenord. Försök igen eller återställ ditt lösenord.',
  'error.originNotAllowed': 'Sidans adress, {origin}, är inte en av appens registrerade adresser i Bridge.',

  'forgot.headingRequest': 'Återställ ditt lösenord',
  'forgot.headingSet': "Välj ett nytt lösenord",
  'forgot.description':
    'Ange din e-postadress så skickar vi en länk för att återställa lösenordet.',
  'forgot.submit': 'Skicka återställningslänk',
  'forgot.setSubmit': 'Spara nytt lösenord',
  'forgot.emailSent': 'Om adressen har ett konto är en länk för att återställa lösenordet på väg.',
  'forgot.successHeading': 'Lösenordet är sparat',
  'forgot.error.send': 'Länken kunde inte skickas. Försök igen om en stund.',
  'forgot.error.update': 'Lösenordet kunde inte ändras. Försök igen eller be om en ny länk.',
  'forgot.error.mismatch': 'Lösenorden stämmer inte överens.',
  'forgot.error.tooShort': "Använd minst 8 tecken.",

  'signup.heading': 'Skapa ditt konto',
  'signup.submit': 'Skapa konto',
  'signup.successHeading': 'Kolla din e-post',
  'signup.successDescription':
    'Vi har skickat en länk till {email}. Öppna den för att skapa klart ditt konto.',
  'signup.loginPrompt': 'Har du redan ett konto?',
  'signup.loginLink': 'Logga in',
  'signup.error.create': 'Kontot kunde inte skapas. Försök igen om en stund.',

  'workspace.chooseHeading': 'Välj arbetsyta',
  'workspace.error.select': 'Arbetsytan kunde inte öppnas. Försök igen.',
  'workspace.error.load': 'Dina arbetsytor kunde inte hämtas. Försök igen.',
  'workspace.error.switch': 'Det gick inte att byta arbetsyta. Försök igen.',


  'verify.finishing': 'Slutför registreringen…',
  'verify.error.wrongDevice': 'Länken fungerar bara i webbläsaren där du registrerade dig. Öppna den där, eller registrera dig igen här.',
  'link.error.invalid': 'Länken är inte längre giltig. Be om en ny.',
  'login.error.flowExpired': 'Det tog för lång tid. Logga in igen.',
  'login.error.unsupportedStep': 'Din arbetsyta kräver ett inloggningssteg som inte finns här än. Be arbetsytans administratör om hjälp.',
  'error.unavailable': "Det här är inte tillgängligt just nu. Försök igen om en stund.",
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
  'action.copied': 'Kopieret',
  'action.tryAgain': 'Prøv igen',
  'action.done': 'Færdig',

  'login.heading': 'Log ind på din konto',
  'login.submit': 'Log ind',
  'login.submitting': 'Logger ind…',
  'login.forgotPassword': 'Glemt adgangskode?',
  'login.signupPrompt': 'Har du ikke en konto?',
  'login.signupLink': 'Opret konto',
  'login.error.invalidCredentials': 'Forkert e-mail eller adgangskode. Prøv igen, eller nulstil din adgangskode.',
  'error.originNotAllowed': 'Sidens adresse, {origin}, er ikke en af appens registrerede adresser i Bridge.',

  'forgot.headingRequest': 'Nulstil din adgangskode',
  'forgot.headingSet': "Vælg en ny adgangskode",
  'forgot.description':
    'Indtast din e-mail, så sender vi dig et link til at nulstille din adgangskode.',
  'forgot.submit': 'Send nulstillingslink',
  'forgot.setSubmit': 'Gem ny adgangskode',
  'forgot.emailSent': 'Hvis adressen har en konto, er et link til at nulstille adgangskoden på vej.',
  'forgot.successHeading': 'Adgangskoden er gemt',
  'forgot.error.send': 'Linket kunne ikke sendes. Prøv igen om lidt.',
  'forgot.error.update': 'Din adgangskode kunne ikke ændres. Prøv igen, eller bed om et nyt link.',
  'forgot.error.mismatch': 'Adgangskoderne er ikke ens.',
  'forgot.error.tooShort': "Brug mindst 8 tegn.",

  'signup.heading': 'Opret din konto',
  'signup.submit': 'Opret konto',
  'signup.successHeading': 'Tjek din e-mail',
  'signup.successDescription':
    'Vi har sendt et link til {email}. Åbn det for at gøre din konto færdig.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Log ind',
  'signup.error.create': 'Din konto kunne ikke oprettes. Prøv igen om lidt.',

  'workspace.chooseHeading': 'Vælg et arbejdsområde',
  'workspace.error.select': 'Arbejdsområdet kunne ikke åbnes. Prøv igen.',
  'workspace.error.load': 'Dine arbejdsområder kunne ikke hentes. Prøv igen.',
  'workspace.error.switch': 'Der kunne ikke skiftes arbejdsområde. Prøv igen.',


  'verify.finishing': 'Afslutter tilmeldingen…',
  'verify.error.wrongDevice': 'Linket virker kun i den browser, hvor du tilmeldte dig. Åbn det der, eller tilmeld dig igen her.',
  'link.error.invalid': 'Linket er ikke længere gyldigt. Bed om et nyt.',
  'login.error.flowExpired': 'Det tog for lang tid. Log ind igen.',
  'login.error.unsupportedStep': 'Dit arbejdsområde kræver et login-trin, som ikke findes her endnu. Bed arbejdsområdets administrator om hjælp.',
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
  'invite.accept': "Tag imod invitationen",
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
  'action.showPasswords': "Vis passordene",
  'action.hidePasswords': "Skjul passordene",
  'action.backToLogin': 'Tilbake til innlogging',
  'action.backToSignIn': 'Tilbake til innlogging',
  'action.copy': 'Kopier',
  'action.copied': 'Kopiert',
  'action.tryAgain': 'Prøv igjen',
  'action.done': 'Ferdig',

  'login.heading': 'Logg inn på kontoen din',
  'login.submit': 'Logg inn',
  'login.submitting': 'Logger inn…',
  'login.forgotPassword': 'Glemt passord?',
  'login.signupPrompt': 'Har du ingen konto?',
  'login.signupLink': 'Opprett konto',
  'login.error.invalidCredentials': 'Feil e-postadresse eller passord. Prøv igjen, eller tilbakestill passordet ditt.',
  'error.originNotAllowed': 'Sidens adresse, {origin}, er ikke en av appens registrerte adresser i Bridge.',

  'forgot.headingRequest': 'Tilbakestill passordet ditt',
  'forgot.headingSet': "Velg et nytt passord",
  'forgot.description':
    'Skriv inn e-postadressen din, så sender vi deg en lenke for å tilbakestille passordet.',
  'forgot.submit': 'Send tilbakestillingslenke',
  'forgot.setSubmit': 'Lagre nytt passord',
  'forgot.emailSent': 'Hvis adressen har en konto, er en tilbakestillingslenke på vei.',
  'forgot.successHeading': 'Passordet er lagret',
  'forgot.error.send': 'Lenken kunne ikke sendes. Prøv igjen om litt.',
  'forgot.error.update': 'Passordet ditt kunne ikke endres. Prøv igjen, eller be om en ny lenke.',
  'forgot.error.mismatch': 'Passordene er ikke like.',
  'forgot.error.tooShort': "Bruk minst 8 tegn.",

  'signup.heading': 'Opprett kontoen din',
  'signup.submit': 'Opprett konto',
  'signup.successHeading': 'Sjekk e-posten din',
  'signup.successDescription':
    'Vi har sendt en lenke til {email}. Åpne den for å fullføre kontoen din.',
  'signup.loginPrompt': 'Har du allerede en konto?',
  'signup.loginLink': 'Logg inn',
  'signup.error.create': 'Kontoen din kunne ikke opprettes. Prøv igjen om litt.',

  'workspace.chooseHeading': 'Velg et arbeidsområde',
  'workspace.error.select': 'Arbeidsområdet kunne ikke åpnes. Prøv igjen.',
  'workspace.error.load': 'Arbeidsområdene dine kunne ikke hentes. Prøv igjen.',
  'workspace.error.switch': 'Kunne ikke bytte arbeidsområde. Prøv igjen.',


  'verify.finishing': 'Fullfører registreringen…',
  'verify.error.wrongDevice': 'Lenken virker bare i nettleseren der du registrerte deg. Åpne den der, eller registrer deg på nytt her.',
  'link.error.invalid': 'Lenken er ikke lenger gyldig. Be om en ny.',
  'login.error.flowExpired': 'Det tok for lang tid. Logg inn på nytt.',
  'login.error.unsupportedStep': 'Arbeidsområdet ditt krever et innloggingstrinn som ikke er tilgjengelig her ennå. Be administratoren for arbeidsområdet om hjelp.',
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
  'invite.accept': "Ta imot invitasjonen",
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
  'action.copied': 'Gekopieerd',
  'action.tryAgain': 'Opnieuw proberen',
  'action.done': 'Klaar',

  'login.heading': 'Log in op je account',
  'login.submit': 'Inloggen',
  'login.submitting': 'Bezig met inloggen…',
  'login.forgotPassword': 'Wachtwoord vergeten?',
  'login.signupPrompt': 'Nog geen account?',
  'login.signupLink': 'Account aanmaken',
  'login.error.invalidCredentials': 'Onjuist e-mailadres of wachtwoord. Probeer het opnieuw of stel je wachtwoord opnieuw in.',
  'error.originNotAllowed': 'Het adres van deze pagina, {origin}, is niet een van de geregistreerde adressen van deze app in Bridge.',

  'forgot.headingRequest': 'Stel je wachtwoord opnieuw in',
  'forgot.headingSet': "Kies een nieuw wachtwoord",
  'forgot.description':
    'Voer je e-mailadres in, dan sturen we je een link om je wachtwoord opnieuw in te stellen.',
  'forgot.submit': 'Link versturen',
  'forgot.setSubmit': 'Nieuw wachtwoord opslaan',
  'forgot.emailSent': 'Als dit adres een account heeft, is er een link onderweg om je wachtwoord opnieuw in te stellen.',
  'forgot.successHeading': 'Wachtwoord opgeslagen',
  'forgot.error.send': 'De link kon niet worden verstuurd. Probeer het zo opnieuw.',
  'forgot.error.update': 'Je wachtwoord kon niet worden gewijzigd. Probeer het opnieuw of vraag een nieuwe link aan.',
  'forgot.error.mismatch': 'De wachtwoorden komen niet overeen.',
  'forgot.error.tooShort': "Gebruik minstens 8 tekens.",

  'signup.heading': 'Maak je account aan',
  'signup.submit': 'Account aanmaken',
  'signup.successHeading': 'Check je e-mail',
  'signup.successDescription':
    'We hebben een link naar {email} gestuurd. Open hem om je account af te ronden.',
  'signup.loginPrompt': 'Heb je al een account?',
  'signup.loginLink': 'Inloggen',
  'signup.error.create': 'Je account kon niet worden aangemaakt. Probeer het zo opnieuw.',

  'workspace.chooseHeading': 'Kies een werkruimte',
  'workspace.error.select': 'Die werkruimte kon niet worden geopend. Probeer het opnieuw.',
  'workspace.error.load': 'Je werkruimtes konden niet worden geladen. Probeer het opnieuw.',
  'workspace.error.switch': 'Wisselen van werkruimte is niet gelukt. Probeer het opnieuw.',


  'verify.finishing': "Account aanmaken afronden…",
  'verify.error.wrongDevice': "Deze link werkt alleen in de browser waarin je je account hebt aangemaakt. Open hem daar, of maak hier opnieuw een account aan.",
  'link.error.invalid': 'Deze link is niet meer geldig. Vraag een nieuwe aan.',
  'login.error.flowExpired': 'Dat duurde te lang. Log opnieuw in.',
  'login.error.unsupportedStep': 'Je werkruimte vraagt een inlogstap die hier nog niet beschikbaar is. Vraag de beheerder van je werkruimte om hulp.',
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
  'invite.accept': "Uitnodiging aannemen",
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
  'action.copied': 'Kopiert',
  'action.tryAgain': 'Erneut versuchen',
  'action.done': 'Fertig',

  'login.heading': 'Bei deinem Konto anmelden',
  'login.submit': 'Anmelden',
  'login.submitting': 'Anmeldung läuft…',
  'login.forgotPassword': 'Passwort vergessen?',
  'login.signupPrompt': 'Noch kein Konto?',
  'login.signupLink': 'Konto erstellen',
  'login.error.invalidCredentials': 'E-Mail-Adresse oder Passwort ist falsch. Versuche es erneut oder setze dein Passwort zurück.',
  'error.originNotAllowed': 'Die Adresse dieser Seite, {origin}, gehört nicht zu den registrierten Adressen dieser App in Bridge.',

  'forgot.headingRequest': 'Passwort zurücksetzen',
  'forgot.headingSet': "Wähle ein neues Passwort",
  'forgot.description':
    'Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Link zum Zurücksetzen deines Passworts.',
  'forgot.submit': "Link zum Zurücksetzen senden",
  'forgot.setSubmit': 'Neues Passwort speichern',
  'forgot.emailSent': 'Wenn es für diese Adresse ein Konto gibt, ist ein Link zum Zurücksetzen deines Passworts unterwegs.',
  'forgot.successHeading': 'Passwort gespeichert',
  'forgot.error.send': 'Der Link konnte nicht gesendet werden. Versuche es gleich noch einmal.',
  'forgot.error.update': 'Dein Passwort konnte nicht geändert werden. Versuche es erneut oder fordere einen neuen Link an.',
  'forgot.error.mismatch': 'Die Passwörter stimmen nicht überein.',
  'forgot.error.tooShort': "Verwende mindestens 8 Zeichen.",

  'signup.heading': 'Konto erstellen',
  'signup.submit': 'Konto erstellen',
  'signup.successHeading': 'Sieh in deinem Postfach nach',
  'signup.successDescription':
    'Wir haben einen Link an {email} geschickt. Öffne ihn, um dein Konto fertig einzurichten.',
  'signup.loginPrompt': 'Du hast schon ein Konto?',
  'signup.loginLink': 'Anmelden',
  'signup.error.create': 'Dein Konto konnte nicht erstellt werden. Versuche es gleich noch einmal.',

  'workspace.chooseHeading': 'Arbeitsbereich auswählen',
  'workspace.error.select': 'Dieser Arbeitsbereich konnte nicht geöffnet werden. Versuche es erneut.',
  'workspace.error.load': 'Deine Arbeitsbereiche konnten nicht geladen werden. Versuche es erneut.',
  'workspace.error.switch': 'Der Arbeitsbereich konnte nicht gewechselt werden. Versuche es erneut.',


  'verify.finishing': 'Registrierung wird abgeschlossen…',
  'verify.error.wrongDevice': 'Dieser Link funktioniert nur in dem Browser, in dem du dich registriert hast. Öffne ihn dort oder registriere dich hier erneut.',
  'link.error.invalid': 'Dieser Link ist nicht mehr gültig. Fordere einen neuen an.',
  'login.error.flowExpired': 'Das hat zu lange gedauert. Melde dich erneut an.',
  'login.error.unsupportedStep': 'Dein Arbeitsbereich verlangt einen Anmeldeschritt, der hier noch nicht verfügbar ist. Wende dich an die Admins deines Arbeitsbereichs.',
  'error.unavailable': 'Das ist gerade nicht verfügbar. Versuche es gleich noch einmal.',
  'error.network': 'Keine Verbindung möglich. Prüfe deine Verbindung und versuche es erneut.',
  'error.rateLimited': 'Zu viele Versuche. Warte einen Moment und versuche es erneut.',
  'login.error.tooManyAttempts': "Zu viele Versuche. Versuche es in {minutes} Minuten erneut.",
  'login.error.tooManyAttemptsOneMinute': "Zu viele Versuche. Versuche es in 1 Minute erneut.",
  'login.error.accountLocked': "Zu viele Versuche. Dieses Konto ist gesperrt. Setze dein Passwort zurück, um dich wieder anzumelden.",
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
  'action.copied': 'Kopioitu',
  'action.tryAgain': 'Yritä uudelleen',
  'action.done': 'Valmis',

  'login.heading': 'Kirjaudu tilillesi',
  'login.submit': 'Kirjaudu sisään',
  'login.submitting': 'Kirjaudutaan…',
  'login.forgotPassword': 'Unohtuiko salasana?',
  'login.signupPrompt': 'Eikö sinulla ole tiliä?',
  'login.signupLink': 'Luo tili',
  'login.error.invalidCredentials': 'Väärä sähköpostiosoite tai salasana. Yritä uudelleen tai nollaa salasanasi.',
  'error.originNotAllowed': 'Tämän sivun osoite, {origin}, ei ole yksi sovelluksen rekisteröidyistä osoitteista Bridgessä.',

  'forgot.headingRequest': 'Nollaa salasanasi',
  'forgot.headingSet': "Valitse uusi salasana",
  'forgot.description':
    'Kirjoita sähköpostiosoitteesi, niin lähetämme linkin salasanan nollaamiseen.',
  'forgot.submit': 'Lähetä nollauslinkki',
  'forgot.setSubmit': 'Tallenna uusi salasana',
  'forgot.emailSent': 'Jos osoitteella on tili, linkki salasanan nollaamiseen on matkalla.',
  'forgot.successHeading': 'Salasana tallennettu',
  'forgot.error.send': 'Linkkiä ei voitu lähettää. Yritä hetken päästä uudelleen.',
  'forgot.error.update': 'Salasanaa ei voitu vaihtaa. Yritä uudelleen tai pyydä uusi linkki.',
  'forgot.error.mismatch': 'Salasanat eivät täsmää.',
  'forgot.error.tooShort': "Käytä vähintään 8 merkkiä.",

  'signup.heading': 'Luo tilisi',
  'signup.submit': 'Luo tili',
  'signup.successHeading': 'Tarkista sähköpostisi',
  'signup.successDescription':
    'Lähetimme linkin osoitteeseen {email}. Avaa se, niin tilisi on valmis.',
  'signup.loginPrompt': 'Onko sinulla jo tili?',
  'signup.loginLink': 'Kirjaudu sisään',
  'signup.error.create': 'Tiliä ei voitu luoda. Yritä hetken päästä uudelleen.',

  'workspace.chooseHeading': 'Valitse työtila',
  'workspace.error.select': 'Työtilaa ei voitu avata. Yritä uudelleen.',
  'workspace.error.load': 'Työtiloja ei voitu ladata. Yritä uudelleen.',
  'workspace.error.switch': 'Työtilaa ei voitu vaihtaa. Yritä uudelleen.',


  'verify.finishing': 'Viimeistellään rekisteröitymistä…',
  'verify.error.wrongDevice': 'Linkki toimii vain selaimessa, jossa rekisteröidyit. Avaa se siellä tai rekisteröidy uudelleen tässä.',
  'link.error.invalid': 'Linkki ei ole enää voimassa. Pyydä uusi.',
  'login.error.flowExpired': 'Kirjautuminen kesti liian kauan. Kirjaudu sisään uudelleen.',
  'login.error.unsupportedStep': 'Työtilasi vaatii kirjautumisvaiheen, joka ei ole vielä käytettävissä täällä. Pyydä apua työtilasi ylläpitäjältä.',
  'error.unavailable': 'Tämä ei ole juuri nyt käytettävissä. Yritä hetken päästä uudelleen.',
  'error.network': 'Yhteyttä ei saatu. Tarkista yhteys ja yritä uudelleen.',
  'error.rateLimited': 'Liian monta yritystä. Odota hetki ja yritä uudelleen.',
  'login.error.tooManyAttempts': 'Liian monta yritystä. Yritä uudelleen {minutes} minuutin kuluttua.',
  'login.error.tooManyAttemptsOneMinute': 'Liian monta yritystä. Yritä uudelleen 1 minuutin kuluttua.',
  'login.error.accountLocked': 'Liian monta yritystä. Tili on lukittu. Nollaa salasanasi kirjautuaksesi uudelleen.',
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
  'action.copied': 'Copié',
  'action.tryAgain': 'Réessayer',
  'action.done': 'Terminé',

  'login.heading': 'Connecte-toi à ton compte',
  'login.submit': 'Se connecter',
  'login.submitting': 'Connexion…',
  'login.forgotPassword': 'Mot de passe oublié ?',
  'login.signupPrompt': 'Tu n’as pas de compte ?',
  'login.signupLink': 'Créer un compte',
  'login.error.invalidCredentials': 'E-mail ou mot de passe incorrect. Réessaie, ou réinitialise ton mot de passe.',
  'error.originNotAllowed': "L’adresse de cette page, {origin}, ne fait pas partie des adresses enregistrées de cette application dans Bridge.",

  'forgot.headingRequest': 'Réinitialise ton mot de passe',
  'forgot.headingSet': "Choisis un nouveau mot de passe",
  'forgot.description':
    'Saisis ton e-mail et nous t’enverrons un lien pour réinitialiser ton mot de passe.',
  'forgot.submit': 'Envoyer le lien',
  'forgot.setSubmit': 'Enregistrer le nouveau mot de passe',
  'forgot.emailSent': 'Si cette adresse a un compte, un lien pour réinitialiser ton mot de passe est en route.',
  'forgot.successHeading': 'Mot de passe enregistré',
  'forgot.error.send': 'Le lien n’a pas pu être envoyé. Réessaie dans un instant.',
  'forgot.error.update': 'Ton mot de passe n’a pas pu être modifié. Réessaie, ou demande un nouveau lien.',
  'forgot.error.mismatch': 'Les mots de passe ne correspondent pas.',
  'forgot.error.tooShort': "Utilise au moins 8 caractères.",

  'signup.heading': 'Crée ton compte',
  'signup.submit': 'Créer un compte',
  'signup.successHeading': 'Consulte ta boîte mail',
  'signup.successDescription':
    'Nous avons envoyé un lien à {email}. Ouvre-le pour finaliser ton compte.',
  'signup.loginPrompt': 'Tu as déjà un compte ?',
  'signup.loginLink': 'Se connecter',
  'signup.error.create': 'Ton compte n’a pas pu être créé. Réessaie dans un instant.',

  'workspace.chooseHeading': 'Choisis un espace de travail',
  'workspace.error.select': 'Cet espace de travail n’a pas pu être ouvert. Réessaie.',
  'workspace.error.load': 'Tes espaces de travail n’ont pas pu être chargés. Réessaie.',
  'workspace.error.switch': 'L’espace de travail n’a pas pu être changé. Réessaie.',


  'verify.finishing': 'Finalisation de l’inscription…',
  'verify.error.wrongDevice': 'Ce lien ne fonctionne que dans le navigateur où tu t’es inscrit. Ouvre-le là-bas, ou inscris-toi de nouveau ici.',
  'link.error.invalid': 'Ce lien n’est plus valide. Demandes-en un nouveau.',
  'login.error.flowExpired': "Cela a pris trop de temps. Reconnecte-toi.",
  'login.error.unsupportedStep': 'Ton espace de travail demande une étape de connexion qui n’est pas encore disponible ici. Demande de l’aide à l’administrateur de ton espace de travail.',
  'error.unavailable': 'Ce n’est pas disponible pour le moment. Réessaie dans un instant.',
  'error.network': 'Connexion impossible. Vérifie ta connexion et réessaie.',
  'error.rateLimited': 'Trop de tentatives. Patiente un instant et réessaie.',
  'login.error.tooManyAttempts': "Trop de tentatives. Réessaie dans {minutes} minutes.",
  'login.error.tooManyAttemptsOneMinute': "Trop de tentatives. Réessaie dans 1 minute.",
  'login.error.accountLocked': "Trop de tentatives. Ce compte est verrouillé. Réinitialise ton mot de passe pour te reconnecter.",
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
  'action.copied': 'Copiado',
  'action.tryAgain': 'Inténtalo de nuevo',
  'action.done': 'Hecho',

  'login.heading': 'Inicia sesión en tu cuenta',
  'login.submit': 'Iniciar sesión',
  'login.submitting': 'Iniciando sesión…',
  'login.forgotPassword': '¿Olvidaste tu contraseña?',
  'login.signupPrompt': '¿Aún no tienes cuenta?',
  'login.signupLink': 'Crear cuenta',
  'login.error.invalidCredentials': 'Correo electrónico o contraseña incorrectos. Inténtalo de nuevo o restablece tu contraseña.',
  'error.originNotAllowed': "La dirección de esta página, {origin}, no es una de las direcciones registradas de esta aplicación en Bridge.",

  'forgot.headingRequest': 'Restablece tu contraseña',
  'forgot.headingSet': "Elige una nueva contraseña",
  'forgot.description':
    'Escribe tu correo electrónico y te enviaremos un enlace para restablecer la contraseña.',
  'forgot.submit': "Enviar enlace de restablecimiento",
  'forgot.setSubmit': 'Guardar la contraseña nueva',
  'forgot.emailSent': 'Si esta dirección tiene una cuenta, te llegará un enlace para restablecer la contraseña.',
  'forgot.successHeading': 'Contraseña guardada',
  'forgot.error.send': 'No se ha podido enviar el enlace. Inténtalo de nuevo en un momento.',
  'forgot.error.update': 'No se ha podido cambiar tu contraseña. Inténtalo de nuevo o pide un enlace nuevo.',
  'forgot.error.mismatch': 'Las contraseñas no coinciden.',
  'forgot.error.tooShort': "Usa al menos 8 caracteres.",

  'signup.heading': 'Crea tu cuenta',
  'signup.submit': 'Crear cuenta',
  'signup.successHeading': 'Revisa tu correo',
  'signup.successDescription':
    'Hemos enviado un enlace a {email}. Ábrelo para terminar de crear tu cuenta.',
  'signup.loginPrompt': '¿Ya tienes cuenta?',
  'signup.loginLink': 'Iniciar sesión',
  'signup.error.create': 'No se ha podido crear tu cuenta. Inténtalo de nuevo en un momento.',

  'workspace.chooseHeading': 'Elige un espacio de trabajo',
  'workspace.error.select': 'No se ha podido abrir ese espacio de trabajo. Inténtalo de nuevo.',
  'workspace.error.load': 'No se han podido cargar tus espacios de trabajo. Inténtalo de nuevo.',
  'workspace.error.switch': 'No se ha podido cambiar de espacio de trabajo. Inténtalo de nuevo.',


  'verify.finishing': 'Completando el registro…',
  'verify.error.wrongDevice': 'Este enlace solo funciona en el navegador en el que te registraste. Ábrelo allí o regístrate de nuevo aquí.',
  'link.error.invalid': 'Este enlace ya no es válido. Pide uno nuevo.',
  'login.error.flowExpired': 'Ha tardado demasiado. Vuelve a iniciar sesión.',
  'login.error.unsupportedStep': 'Tu espacio de trabajo pide un paso de inicio de sesión que aún no está disponible aquí. Pide ayuda a quien administra tu espacio de trabajo.',
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
  'action.copied': 'Copiato',
  'action.tryAgain': 'Riprova',
  'action.done': 'Fatto',

  'login.heading': 'Accedi al tuo account',
  'login.submit': 'Accedi',
  'login.submitting': 'Accesso in corso…',
  'login.forgotPassword': 'Password dimenticata?',
  'login.signupPrompt': 'Non hai un account?',
  'login.signupLink': 'Crea un account',
  'login.error.invalidCredentials': 'E-mail o password non corretti. Riprova oppure reimposta la password.',
  'error.originNotAllowed': 'L’indirizzo di questa pagina, {origin}, non è tra gli indirizzi registrati di questa app in Bridge.',

  'forgot.headingRequest': 'Reimposta la tua password',
  'forgot.headingSet': "Scegli una nuova password",
  'forgot.description':
    'Inserisci la tua e-mail e ti invieremo un link per reimpostare la password.',
  'forgot.submit': 'Invia il link',
  'forgot.setSubmit': 'Salva la nuova password',
  'forgot.emailSent': 'Se questo indirizzo ha un account, ti stiamo inviando un link per reimpostare la password.',
  'forgot.successHeading': 'Password salvata',
  'forgot.error.send': 'Non è stato possibile inviare il link. Riprova tra poco.',
  'forgot.error.update': 'Non è stato possibile cambiare la password. Riprova oppure chiedi un nuovo link.',
  'forgot.error.mismatch': 'Le password non coincidono.',
  'forgot.error.tooShort': "Usa almeno 8 caratteri.",

  'signup.heading': 'Crea il tuo account',
  'signup.submit': "Crea un account",
  'signup.successHeading': 'Controlla la tua e-mail',
  'signup.successDescription':
    'Abbiamo inviato un link a {email}. Aprilo per completare il tuo account.',
  'signup.loginPrompt': 'Hai già un account?',
  'signup.loginLink': 'Accedi',
  'signup.error.create': 'Non è stato possibile creare il tuo account. Riprova tra poco.',

  'workspace.chooseHeading': 'Scegli uno spazio di lavoro',
  'workspace.error.select': 'Non è stato possibile aprire quello spazio di lavoro. Riprova.',
  'workspace.error.load': 'Non è stato possibile caricare i tuoi spazi di lavoro. Riprova.',
  'workspace.error.switch': 'Non è stato possibile cambiare spazio di lavoro. Riprova.',


  'verify.finishing': 'Completamento della registrazione…',
  'verify.error.wrongDevice': 'Questo link funziona solo nel browser in cui ti sei registrato. Aprilo lì oppure registrati di nuovo qui.',
  'link.error.invalid': 'Questo link non è più valido. Richiedine uno nuovo.',
  'login.error.flowExpired': 'Ci è voluto troppo tempo. Accedi di nuovo.',
  'login.error.unsupportedStep': 'Il tuo spazio di lavoro richiede un passaggio di accesso non ancora disponibile qui. Chiedi aiuto all’amministratore del tuo spazio di lavoro.',
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
  'action.copied': 'Copiado',
  'action.tryAgain': 'Tenta novamente',
  'action.done': 'Concluído',

  'login.heading': 'Inicia sessão na tua conta',
  'login.submit': 'Iniciar sessão',
  'login.submitting': 'A iniciar sessão…',
  'login.forgotPassword': 'Esqueceste-te da palavra-passe?',
  'login.signupPrompt': 'Ainda não tens conta?',
  'login.signupLink': 'Criar conta',
  'login.error.invalidCredentials': "E-mail ou palavra-passe incorretos. Tenta novamente ou redefine a tua palavra-passe.",
  'error.originNotAllowed': "O endereço desta página, {origin}, não é um dos endereços registados desta aplicação no Bridge.",

  'forgot.headingRequest': "Redefine a tua palavra-passe",
  'forgot.headingSet': "Escolhe uma nova palavra-passe",
  'forgot.description':
    "Introduz o teu e-mail e enviamos-te um link para redefinas a palavra-passe.",
  'forgot.submit': "Enviar link de redefinição",
  'forgot.setSubmit': 'Guardar nova palavra-passe',
  'forgot.emailSent': 'Se este endereço tiver uma conta, vais receber um link para repor a palavra-passe.',
  'forgot.successHeading': 'Palavra-passe guardada',
  'forgot.error.send': 'Não foi possível enviar o link. Tenta novamente daqui a pouco.',
  'forgot.error.update': 'Não foi possível alterar a tua palavra-passe. Tenta novamente ou pede um novo link.',
  'forgot.error.mismatch': 'As palavras-passe não coincidem.',
  'forgot.error.tooShort': "Usa pelo menos 8 caracteres.",

  'signup.heading': 'Cria a tua conta',
  'signup.submit': 'Criar conta',
  'signup.successHeading': 'Vê o teu e-mail',
  'signup.successDescription':
    "Enviámos um link para {email}. Abre-o para concluíres a criação da tua conta.",
  'signup.loginPrompt': 'Já tens conta?',
  'signup.loginLink': 'Iniciar sessão',
  'signup.error.create': 'Não foi possível criar a tua conta. Tenta novamente daqui a pouco.',

  'workspace.chooseHeading': 'Escolhe um espaço de trabalho',
  'workspace.error.select': 'Não foi possível abrir esse espaço de trabalho. Tenta novamente.',
  'workspace.error.load': 'Não foi possível carregar os teus espaços de trabalho. Tenta novamente.',
  'workspace.error.switch': 'Não foi possível mudar de espaço de trabalho. Tenta novamente.',


  'verify.finishing': 'A concluir o registo…',
  'verify.error.wrongDevice': "Esta link só funciona no navegador em que te registaste. Abre-a lá ou regista-te de novo aqui.",
  'link.error.invalid': "Esta link já não é válida. Pede um novo.",
  'login.error.flowExpired': 'Demorou demasiado. Inicia sessão novamente.',
  'login.error.unsupportedStep': 'O teu espaço de trabalho pede um passo de início de sessão que ainda não está disponível aqui. Pede ajuda ao administrador do teu espaço de trabalho.',
  'error.unavailable': 'Não está disponível neste momento. Tenta novamente daqui a pouco.',
  'error.network': "Não foi possível ligar. Verifica a tua ligação à internet e tenta novamente.",
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
  'action.copied': 'Skopiowano',
  'action.tryAgain': 'Spróbuj ponownie',
  'action.done': 'Gotowe',

  'login.heading': 'Zaloguj się na swoje konto',
  'login.submit': 'Zaloguj się',
  'login.submitting': 'Logowanie…',
  'login.forgotPassword': 'Nie pamiętasz hasła?',
  'login.signupPrompt': 'Nie masz jeszcze konta?',
  'login.signupLink': 'Załóż konto',
  'login.error.invalidCredentials': 'Nieprawidłowy e-mail lub hasło. Spróbuj ponownie albo zresetuj hasło.',
  'error.originNotAllowed': 'Adres tej strony, {origin}, nie należy do zarejestrowanych adresów tej aplikacji w Bridge.',

  'forgot.headingRequest': 'Zresetuj hasło',
  'forgot.headingSet': "Wybierz nowe hasło",
  'forgot.description':
    'Podaj swój e-mail, a wyślemy Ci link do zresetowania hasła.',
  'forgot.submit': 'Wyślij link resetujący',
  'forgot.setSubmit': 'Zapisz nowe hasło',
  'forgot.emailSent': 'Jeśli ten adres ma konto, link do zresetowania hasła jest już w drodze.',
  'forgot.successHeading': 'Hasło zapisane',
  'forgot.error.send': 'Nie udało się wysłać linku. Spróbuj ponownie za chwilę.',
  'forgot.error.update': 'Nie udało się zmienić hasła. Spróbuj ponownie albo poproś o nowy link.',
  'forgot.error.mismatch': 'Hasła nie są takie same.',
  'forgot.error.tooShort': "Użyj co najmniej 8 znaków.",

  'signup.heading': 'Załóż konto',
  'signup.submit': 'Załóż konto',
  'signup.successHeading': 'Sprawdź skrzynkę',
  'signup.successDescription':
    'Wysłaliśmy link na adres {email}. Otwórz go, aby dokończyć zakładanie konta.',
  'signup.loginPrompt': 'Masz już konto?',
  'signup.loginLink': 'Zaloguj się',
  'signup.error.create': 'Nie udało się założyć konta. Spróbuj ponownie za chwilę.',

  'workspace.chooseHeading': 'Wybierz przestrzeń roboczą',
  'workspace.error.select': 'Nie udało się otworzyć tej przestrzeni roboczej. Spróbuj ponownie.',
  'workspace.error.load': 'Nie udało się wczytać Twoich przestrzeni roboczych. Spróbuj ponownie.',
  'workspace.error.switch': 'Nie udało się zmienić przestrzeni roboczej. Spróbuj ponownie.',


  'verify.finishing': 'Kończenie rejestracji…',
  'verify.error.wrongDevice': 'Ten link działa tylko w przeglądarce, w której rozpoczęto rejestrację. Otwórz go tam albo zarejestruj się ponownie tutaj.',
  'link.error.invalid': 'Ten link nie jest już ważny. Poproś o nowy.',
  'login.error.flowExpired': 'Trwało to zbyt długo. Zaloguj się ponownie.',
  'login.error.unsupportedStep': 'Twoja przestrzeń robocza wymaga kroku logowania, który nie jest tu jeszcze dostępny. Poproś o pomoc administratora przestrzeni roboczej.',
  'error.unavailable': 'Ta funkcja jest teraz niedostępna. Spróbuj ponownie za chwilę.',
  'error.network': 'Nie udało się połączyć. Sprawdź połączenie i spróbuj ponownie.',
  'error.rateLimited': 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.',
  'login.error.tooManyAttempts': 'Zbyt wiele prób. Spróbuj ponownie za {minutes} min.',
  'login.error.tooManyAttemptsOneMinute': 'Zbyt wiele prób. Spróbuj ponownie za minutę.',
  'login.error.accountLocked': 'Zbyt wiele prób. To konto jest zablokowane. Zresetuj hasło, aby zalogować się ponownie.',
  'handoff.heading': 'Zaloguj się do {program}',
  'handoff.done': 'Zalogowano. Możesz zamknąć tę kartę i wrócić do {program}.',
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
