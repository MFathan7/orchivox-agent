import { httpMethods } from './http-methods.js';
const knownMethods = httpMethods;
/** Type guard which takes in a string and returns true if it is in fact an HTTPMethod */
export const isHttpMethod = (method) => method && typeof method === 'string' ? knownMethods.has(method.toLowerCase()) : false;
