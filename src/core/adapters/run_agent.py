import sys
import asyncio
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

async def main():
    if len(sys.argv) < 2:
        print("Error: Prompt is required")
        sys.exit(1)
        
    prompt = sys.argv[1]
    
    # Configure the agent. We pass capabilities=CapabilitiesConfig() to enable write tools
    # if the agent needs to edit files.
    config = LocalAgentConfig(capabilities=CapabilitiesConfig())
    
    try:
        # Spawn the agent using the async context manager
        async with Agent(config) as agent:
            response = await agent.chat(prompt)
            # Stream the response tokens as they arrive
            async for token in response:
                sys.stdout.write(token)
                sys.stdout.flush()
            print()
    except Exception as e:
        print(f"Error starting agent: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
