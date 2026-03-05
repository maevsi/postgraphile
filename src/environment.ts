/**
 * Validates and retrieves required environment variables
 * @param requiredKeys - Array of required environment variable names
 * @returns Object with the validated environment variables
 * @throws {Error} If any required environment variables are missing
 */
export const getValidatedEnvironment = <const T extends readonly string[]>(
  requiredKeys: T,
): Record<T[number], string> => {
  const required = Object.fromEntries(
    requiredKeys.map((key) => [key, process.env[key]]),
  )

  const missing = requiredKeys.filter((key) => !process.env[key])

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    )
  }

  return required as Record<T[number], string>
}
