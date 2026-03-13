/**
 * IIFE entry for userscript - exports PageAgent only, no auto-init.
 * Instance creation is fully controlled by the userscript.
 */
import { PageAgent } from './PageAgent'

window.PageAgent = PageAgent
